"""Guard for the Maven build policy of the backend (standard library only; the scratch-project cases need Maven and network).

What a build may fetch, and from where, decides what ends up in the jar:

- `backend/.mvn/maven.config` makes Maven fail on a checksum mismatch (`--strict-checksums`; the default only warns), for the local
  build, CI and the Docker image build alike. It guards against corrupted or tampered transfers, not against a compromised artifact:
  the artifacts are not signature-checked (see docs/SECURITY.md, "Supply chain", for why pgpverify is not used);
- `maven-enforcer-plugin` runs in the `validate` phase of every build and refuses a Maven or Java that is too old and any repository
  other than Maven Central (a repository added to the pom, or to a plugin, would be a second place that artifacts come from);
- the Dockerfile copies `.mvn/` into the image build, so the policy applies there too.

The scratch cases build a tiny project with the exact enforcer block of `backend/pom.xml` and prove that a foreign repository fails
the build. They need `mvn` and Maven Central; set REQUIRE_MAVEN=1 (CI does) to fail instead of skipping when `mvn` is missing.

run: python scripts/test_maven_policy.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
POM = BACKEND / "pom.xml"
MAVEN_CONFIG = BACKEND / ".mvn" / "maven.config"
DOCKERFILE = BACKEND / "Dockerfile"
CENTRAL = "https://repo.maven.apache.org/maven2"


def enforcer_block(pom):
    found = re.search(r"<plugin>\s*<groupId>org\.apache\.maven\.plugins</groupId>\s*<artifactId>maven-enforcer-plugin</artifactId>.*?</plugin>", pom, re.S)
    return found.group(0) if found else None


def block(pom, tag):
    found = re.search(rf"<{tag}>.*?</{tag}>", pom, re.S)
    return found.group(0) if found else None


def strip_comments(xml):
    return re.sub(r"<!--.*?-->", "", xml, flags=re.S)


def policy_problems(pom, config, dockerfile):
    """What is missing from the pom, the maven.config and the Dockerfile (text checks)."""
    found = []
    code = strip_comments(pom)
    plugin = enforcer_block(code)
    if not plugin:
        found.append("backend/pom.xml has no maven-enforcer-plugin")
    else:
        if "<goal>enforce</goal>" not in plugin:
            found.append("the enforcer plugin does not run its `enforce` goal")
        phases = re.findall(r"<phase>(.*?)</phase>", plugin)
        if phases and phases != ["validate"]:
            found.append(f"the enforcer must run in the validate phase, not {phases}")
        for rule in ("requireMavenVersion", "requireJavaVersion", "bannedRepositories"):
            if f"<{rule}>" not in plugin:
                found.append(f"the enforcer has no `{rule}` rule")
        if plugin.count(f"<allowedRepository>{CENTRAL}</allowedRepository>") != 1 or plugin.count(f"<allowedPluginRepository>{CENTRAL}</allowedPluginRepository>") != 1:
            found.append(f"the only allowed repository and plugin repository must be {CENTRAL}")
        # An allowed list bans every repository that does not match it. A banned pattern "*" would ban Maven Central too.
        if re.search(r"<(bannedRepository|bannedPluginRepository)>", plugin):
            found.append("list only the allowed repositories: the rule bans every other one by itself, and a banned pattern would also match Central")
    if re.search(r"<(repositories|pluginRepositories)>", code):
        found.append("backend/pom.xml declares its own repositories")
    lines = [line.strip() for line in config.splitlines() if line.strip() and not line.strip().startswith("#")]
    if "--strict-checksums" not in lines:
        found.append("backend/.mvn/maven.config does not contain --strict-checksums")
    copy = next((i for i, line in enumerate(dockerfile.splitlines()) if re.match(r"\s*COPY\s+\.mvn\b", line)), None)
    first_mvn = next((i for i, line in enumerate(dockerfile.splitlines()) if re.match(r"\s*RUN\s+mvn\b", line)), None)
    if copy is None or first_mvn is None or copy > first_mvn:
        found.append("backend/Dockerfile must `COPY .mvn` before its first `RUN mvn`")
    return found


class Policy(unittest.TestCase):
    def test_the_pom_is_well_formed_xml(self):
        # A comment with two dashes in it (such as a command line option) makes Maven refuse the whole pom.
        ElementTree.parse(POM)

    def test_the_backend_keeps_its_policy(self):
        found = policy_problems(POM.read_text(encoding="utf-8"), MAVEN_CONFIG.read_text(encoding="utf-8") if MAVEN_CONFIG.exists() else "", DOCKERFILE.read_text(encoding="utf-8"))
        self.assertEqual([], found, "\n" + "\n".join(found))

    def test_no_build_file_switches_the_policy_off(self):
        names = ("enforcer.skip", "--lax-checksums", "-Dmaven.wagon.http.ssl.insecure", "--ignore-checksums")
        files = [*sorted((ROOT / ".github" / "workflows").glob("*.yml")), DOCKERFILE, POM, MAVEN_CONFIG]
        for path in files:
            if not path.exists():
                continue
            text = path.read_text(encoding="utf-8")
            for name in names:
                self.assertNotIn(name, text, f"{path.name} contains {name}")

    GOOD_POM = """<project>
<parent><groupId>g</groupId><artifactId>a</artifactId><version>1</version></parent>
<build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-enforcer-plugin</artifactId>
<executions><execution><goals><goal>enforce</goal></goals><phase>validate</phase><configuration><rules>
<requireMavenVersion><version>[3.9.0,)</version></requireMavenVersion>
<requireJavaVersion><version>[25,)</version></requireJavaVersion>
<bannedRepositories>
<allowedRepositories><allowedRepository>https://repo.maven.apache.org/maven2</allowedRepository></allowedRepositories>
<allowedPluginRepositories><allowedPluginRepository>https://repo.maven.apache.org/maven2</allowedPluginRepository></allowedPluginRepositories>
</bannedRepositories>
</rules></configuration></execution></executions></plugin></plugins></build></project>"""
    GOOD_DOCKERFILE = "FROM x\nCOPY pom.xml .\nCOPY .mvn .mvn\nRUN mvn -B dependency:go-offline\n"

    def test_a_complete_policy_passes_and_each_gap_is_found(self):
        self.assertEqual([], policy_problems(self.GOOD_POM, "--strict-checksums\n", self.GOOD_DOCKERFILE))
        self.assertTrue(policy_problems(self.GOOD_POM.replace("maven-enforcer-plugin", "maven-other-plugin"), "--strict-checksums\n", self.GOOD_DOCKERFILE))
        self.assertTrue(policy_problems(self.GOOD_POM.replace("<requireJavaVersion>", "<x>").replace("</requireJavaVersion>", "</x>"), "--strict-checksums\n", self.GOOD_DOCKERFILE))
        self.assertTrue(policy_problems(self.GOOD_POM.replace("<allowedRepositories>", "<bannedRepositories><bannedRepository>*</bannedRepository></bannedRepositories><allowedRepositories>"), "--strict-checksums\n", self.GOOD_DOCKERFILE))
        self.assertTrue(policy_problems(self.GOOD_POM.replace("<phase>validate</phase>", "<phase>verify</phase>"), "--strict-checksums\n", self.GOOD_DOCKERFILE))
        self.assertTrue(policy_problems(self.GOOD_POM.replace("</build>", "</build><repositories><repository><id>x</id></repository></repositories>"), "--strict-checksums\n", self.GOOD_DOCKERFILE))
        self.assertTrue(policy_problems(self.GOOD_POM, "-B\n", self.GOOD_DOCKERFILE))
        self.assertTrue(policy_problems(self.GOOD_POM, "# --strict-checksums\n", self.GOOD_DOCKERFILE))
        self.assertTrue(policy_problems(self.GOOD_POM, "--strict-checksums\n", "FROM x\nRUN mvn -B package\nCOPY .mvn .mvn\n"))
        self.assertTrue(policy_problems(self.GOOD_POM, "--strict-checksums\n", "FROM x\nRUN mvn -B package\n"))
        self.assertTrue(policy_problems(self.GOOD_POM.replace("https://repo.maven.apache.org/maven2", "https://repo.example.invalid/m2"), "--strict-checksums\n", self.GOOD_DOCKERFILE))

    def test_a_commented_out_rule_does_not_count(self):
        commented = self.GOOD_POM.replace("<requireMavenVersion>", "<!--<requireMavenVersion>").replace("</requireMavenVersion>", "</requireMavenVersion>-->")
        self.assertTrue(policy_problems(commented, "--strict-checksums\n", self.GOOD_DOCKERFILE))


class Scratch(unittest.TestCase):
    """Build a tiny project with the enforcer block of backend/pom.xml and let Maven refuse a foreign repository."""

    @classmethod
    def setUpClass(cls):
        cls.mvn = shutil.which("mvn")
        if not cls.mvn:
            if os.environ.get("REQUIRE_MAVEN") == "1":
                raise AssertionError("REQUIRE_MAVEN=1 but mvn is not available")
            raise unittest.SkipTest("mvn is not available")
        pom = POM.read_text(encoding="utf-8")
        cls.plugin = enforcer_block(pom)
        cls.parent = block(pom, "parent")
        # The scratch project is about repositories, not about the JDK of the machine: the CI python job runs a default JDK that is older
        # than the one the backend needs, and the backend build itself (Java 25 in CI) proves the Java rule. The rule keeps its text.
        cls.properties = re.sub(r"<java\.version>[^<]*</java\.version>", "<java.version>1.8</java.version>", block(pom, "properties") or "")
        if not (cls.plugin and cls.parent and cls.properties):
            raise AssertionError("backend/pom.xml has no enforcer plugin, parent or properties block")

    def build(self, extra, java="1.8"):
        properties = self.properties.replace("<java.version>1.8</java.version>", f"<java.version>{java}</java.version>")
        folder = Path(tempfile.mkdtemp(prefix="maven-policy-"))
        self.addCleanup(shutil.rmtree, folder, True)
        (folder / "pom.xml").write_text(
            f"""<project xmlns="http://maven.apache.org/POM/4.0.0">
<modelVersion>4.0.0</modelVersion>
{self.parent}
<groupId>test</groupId><artifactId>scratch</artifactId><version>1</version>
{properties}
{extra}
<build><plugins>{self.plugin}</plugins></build>
</project>
""",
            encoding="utf-8",
        )
        result = subprocess.run([self.mvn, "-B", "-ntp", "-q", "validate"], cwd=folder, capture_output=True, text=True, timeout=600)
        return result.returncode, result.stdout + result.stderr

    def test_a_clean_project_passes(self):
        code, output = self.build("")
        self.assertEqual(0, code, output[-2000:])

    def test_a_java_older_than_the_pom_asks_for_fails_the_build(self):
        code, output = self.build("", java="999")
        self.assertNotEqual(0, code, "the Java rule must refuse a machine whose JDK is older than java.version")
        self.assertIn("Java", output)

    def test_a_foreign_repository_fails_the_build(self):
        code, output = self.build(
            "<repositories><repository><id>foreign</id><url>https://repo.example.invalid/maven2</url></repository></repositories>"
        )
        self.assertNotEqual(0, code, "a repository other than Maven Central must fail the build")
        self.assertIn("repo.example.invalid", output)

    def test_a_foreign_plugin_repository_fails_the_build(self):
        code, output = self.build(
            "<pluginRepositories><pluginRepository><id>foreign</id><url>https://repo.example.invalid/plugins</url></pluginRepository></pluginRepositories>"
        )
        self.assertNotEqual(0, code, "a plugin repository other than Maven Central must fail the build")
        self.assertIn("repo.example.invalid", output)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
