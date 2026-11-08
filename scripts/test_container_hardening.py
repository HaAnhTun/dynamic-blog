"""Guard for the container hardening of docker-compose.yml and the two Dockerfiles (standard library only).

What a code-execution bug in the Next process (untrusted Markdown) or in the backend (untrusted images and ZIP packages) can do is
decided by the container around it. The compose file and the images therefore keep these properties, and this test fails when one
disappears:

- backend, frontend and meilisearch run with `no-new-privileges`, every capability dropped, a read-only root file system (with tmpfs
  for the places that need to be written) and a process limit; postgres drops all capabilities except the few its entrypoint needs;
- the frontend cannot reach the database: postgres lives on an internal network that only the backend joins;
- the backend connects to postgres as a role that can only read and write rows, not as the superuser (issue 051): a new install has
  three roles, and an install from before them (one role) keeps working with the same compose file;
- the application tree of the frontend image is owned by root, not by the user that runs it (issue 071), and the runtime images carry no
  package manager or download/relay tools they do not need (issue 109).

The first part reads the output of `docker compose config` (needs the docker CLI, skipped without it). The second part builds and starts
the stack and looks at the real containers; it is opt-in because it takes minutes:

    CONTAINER_STACK_DOCKER=1 python scripts/test_container_hardening.py          # builds both images with compose
    CONTAINER_STACK_DOCKER=1 CONTAINER_STACK_NO_BUILD=1 python scripts/test_container_hardening.py   # images already built

CI runs the second part in the `images` job of ci.yml.
run: python scripts/test_container_hardening.py
"""
import base64
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = ROOT / "docker-compose.yml"
FRONTEND_DOCKERFILE = ROOT / "frontend" / "Dockerfile"
BACKEND_DOCKERFILE = ROOT / "backend" / "Dockerfile"

# What the postgres entrypoint needs to chown its data directory and drop to the postgres user. Nothing else may be added back.
POSTGRES_CAPABILITIES = {"CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE"}
HARDENED = ("backend", "frontend", "meilisearch")


def docker_ok():
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


def env_file(directory, roles=False, **extra):
    """A .env with every variable the compose file requires, throw-away values.

    `roles=False` is an install from before the three database roles (one role, DB_USERNAME); `roles=True` is a new install."""
    values = {
        "DB_NAME": "blog",
        "DB_USERNAME": "blog_app" if roles else "blog",
        "DB_PASSWORD": secrets.token_hex(16),
        "JWT_SECRET": secrets.token_hex(32),
        "MFA_ENCRYPTION_KEY": base64.b64encode(os.urandom(32)).decode("ascii"),
        "SITE_URL": "http://localhost:3000",
        "VIEWS_TOKEN": secrets.token_hex(16),
        "CLIENT_IP_TOKEN": secrets.token_hex(16),
        "MEILI_MASTER_KEY": secrets.token_hex(16),
    }
    if roles:
        values.update(
            DB_OWNER_USERNAME="blog_owner",
            DB_OWNER_PASSWORD=secrets.token_hex(16),
            DB_ADMIN_USERNAME="blog_admin",
            DB_ADMIN_PASSWORD=secrets.token_hex(16),
        )
    values.update(extra)
    path = Path(directory) / ".env.test"
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")
    return path


def compose_config(env_path, *profiles):
    command = ["docker", "compose", "--env-file", str(env_path), "-f", str(COMPOSE)]
    for profile in profiles:
        command += ["--profile", profile]
    command += ["config", "--format", "json"]
    result = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


@unittest.skipUnless(docker_ok(), "needs the docker CLI with compose")
class ComposeHardening(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="hardening-")
        cls.addClassCleanup(shutil.rmtree, cls.directory, ignore_errors=True)
        cls.config = compose_config(env_file(cls.directory), "search")
        cls.services = cls.config["services"]

    def test_the_stack_has_the_four_services(self):
        self.assertEqual(set(self.services), {"postgres", "backend", "frontend", "meilisearch"})

    def test_no_new_privileges_and_all_capabilities_dropped(self):
        for name in HARDENED + ("postgres",):
            service = self.services[name]
            self.assertIn("no-new-privileges:true", service.get("security_opt", []), name)
            self.assertIn("ALL", service.get("cap_drop", []), name)

    def test_only_the_capabilities_the_database_entrypoint_needs_are_added_back(self):
        for name in HARDENED:
            self.assertEqual(self.services[name].get("cap_add", []), [], f"{name} adds capabilities back")
        added = set(self.services["postgres"].get("cap_add", []))
        self.assertTrue(added <= POSTGRES_CAPABILITIES, f"postgres adds {sorted(added - POSTGRES_CAPABILITIES)}")

    def test_read_only_root_with_tmpfs_for_the_writable_places(self):
        for name in HARDENED + ("postgres",):
            self.assertIs(self.services[name].get("read_only"), True, name)
        self.assertIn("/tmp", self.tmpfs("backend"))
        self.assertIn("/tmp", self.tmpfs("frontend"))
        self.assertIn("/app/.next/cache", self.tmpfs("frontend"))
        self.assertIn("/tmp", self.tmpfs("meilisearch"))
        self.assertIn("/tmp", self.tmpfs("postgres"))
        self.assertIn("/run/postgresql", self.tmpfs("postgres"))

    def tmpfs(self, name):
        return [entry.split(":", 1)[0] for entry in self.services[name].get("tmpfs", [])]

    def tmpfs_bytes(self, name, path):
        for entry in self.services[name].get("tmpfs", []):
            target, _, options = entry.partition(":")
            size = re.search(r"(?:^|,)size=(\d+)([kmg]?)(?:,|$)", options)
            if target == path and size:
                return int(size.group(1)) * {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[size.group(2)]
        raise AssertionError(f"{name} has no tmpfs {path} with a size")

    def test_the_image_cache_limit_fits_the_tmpfs_it_lives_on_and_the_memory_limit(self):
        # Over the tmpfs the least used images are never deleted and every write fails with ENOSPC once it is full; and a tmpfs is memory.
        config = (ROOT / "frontend" / "next.config.ts").read_text(encoding="utf-8")
        limit = int(re.search(r"maximumDiskCacheSize:\s*([\d_]+)", config).group(1).replace("_", ""))
        cache = self.tmpfs_bytes("frontend", "/app/.next/cache")
        self.assertLessEqual(limit * 1.25, cache, "the image cache limit leaves too little room on its tmpfs")
        everything = cache + self.tmpfs_bytes("frontend", "/tmp")
        self.assertLessEqual(everything * 2, int(self.services["frontend"]["mem_limit"]),
                             "the frontend tmpfs mounts may take more than half of its memory limit")

    def test_the_in_memory_cache_handler_is_configured_and_in_the_build_context(self):
        config = (ROOT / "frontend" / "next.config.ts").read_text(encoding="utf-8")
        self.assertRegex(config, r"cacheHandler:\s*join\(process\.cwd\(\), 'cache-handler\.mjs'\)")
        self.assertTrue((ROOT / "frontend" / "cache-handler.mjs").is_file())
        ignore = (ROOT / "frontend" / ".dockerignore").read_text(encoding="utf-8")
        self.assertNotRegex(ignore, r"(?m)^\*\*?/?\*\.mjs\s*$")

    def test_every_service_has_a_process_limit(self):
        for name, service in self.services.items():
            self.assertTrue(isinstance(service.get("pids_limit"), int) and service["pids_limit"] > 0, name)

    def test_the_frontend_cannot_reach_the_database(self):
        networks = self.config["networks"]
        database = set(self.services["postgres"]["networks"])
        self.assertTrue(database, "postgres is on no network")
        for network in database:
            self.assertIs(networks[network].get("internal"), True, f"{network} is not internal: postgres could reach out")
        self.assertEqual(set(self.services["frontend"]["networks"]) & database, set())
        self.assertTrue(set(self.services["backend"]["networks"]) & database, "the backend must reach the database")
        self.assertTrue(set(self.services["backend"]["networks"]) & set(self.services["frontend"]["networks"]),
                        "the backend and the frontend must share a network")

    def test_meilisearch_is_not_on_the_database_network(self):
        self.assertEqual(set(self.services["meilisearch"]["networks"]) & set(self.services["postgres"]["networks"]), set())

    def test_the_backend_reaches_the_internet_for_github_and_mail(self):
        outside = [n for n in self.services["backend"]["networks"] if not self.config["networks"][n].get("internal")]
        self.assertTrue(outside, "the backend needs one network that is not internal (GitHub sign-in, SMTP)")

    def test_only_loopback_ports_are_published(self):
        for name, service in self.services.items():
            for port in service.get("ports", []):
                self.assertEqual(port.get("host_ip"), "127.0.0.1", f"{name} publishes {port}")
        self.assertEqual(self.services["postgres"].get("ports", []), [])
        self.assertEqual(self.services["backend"].get("ports", []), [])

    def test_every_service_has_a_healthcheck_the_stack_waits_for(self):
        for name, service in self.services.items():
            self.assertIn("healthcheck", service, name)
        self.assertEqual(self.services["frontend"]["depends_on"]["backend"]["condition"], "service_healthy")

    def test_the_frontend_is_told_its_address_so_that_it_can_refuse_an_image_built_for_another(self):
        environment = self.services["frontend"]["environment"]
        self.assertEqual(environment["SITE_URL"], "http://localhost:3000")
        self.assertIn("ALLOW_SITE_URL_MISMATCH", environment)
        self.assertEqual(self.services["backend"]["environment"]["SITE_URL"], environment["SITE_URL"])

    def test_memory_limits_stay(self):
        for name, service in self.services.items():
            self.assertTrue(service.get("mem_limit"), name)


@unittest.skipUnless(docker_ok(), "needs the docker CLI with compose")
class DatabaseRoles(unittest.TestCase):
    """How the compose file hands the database roles to postgres and to the backend."""

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="roles-")
        cls.addClassCleanup(shutil.rmtree, cls.directory, ignore_errors=True)
        cls.new = compose_config(env_file(cls.directory, roles=True))["services"]
        cls.old = compose_config(env_file(cls.directory, roles=False))["services"]

    def test_a_new_install_has_a_separate_superuser_owner_and_runtime_role(self):
        postgres, backend = self.new["postgres"]["environment"], self.new["backend"]["environment"]
        self.assertEqual(postgres["POSTGRES_USER"], "blog_admin")
        self.assertEqual(postgres["OWNER_DB_USER"], "blog_owner")
        self.assertEqual(postgres["APP_DB_USER"], "blog_app")
        self.assertEqual(backend["DB_USERNAME"], "blog_app")
        self.assertEqual(backend["SPRING_FLYWAY_USER"], "blog_owner")
        self.assertNotEqual(backend["SPRING_FLYWAY_PASSWORD"], backend["DB_PASSWORD"])
        self.assertNotIn(backend["DB_USERNAME"], (postgres["POSTGRES_USER"], backend["SPRING_FLYWAY_USER"]))
        self.assertNotIn(postgres["POSTGRES_PASSWORD"], (backend["DB_PASSWORD"], backend["SPRING_FLYWAY_PASSWORD"]))

    def run_preflight(self, **given):
        """Runs deploy/postgres-preflight.sh with the environment that Compose renders for a .env, in the real postgres image.

        The script ends in `docker-entrypoint.sh true`, which the image runs as a plain command (no initdb, no server)."""
        env = compose_config(env_file(self.directory, roles=True, **given))["services"]["postgres"]["environment"]
        env_path = Path(self.directory) / "preflight.env"
        env_path.write_text("".join(f"{key}={value}\n" for key, value in env.items()), encoding="utf-8")
        script = ROOT / "deploy" / "postgres-preflight.sh"
        return subprocess.run(
            ["docker", "run", "--rm", "--entrypoint", "sh", "--env-file", str(env_path), "-v", f"{script}:/preflight.sh:ro",
             self.new["postgres"]["image"], "/preflight.sh", "true"],
            capture_output=True, text=True)

    def test_a_half_filled_three_role_env_is_refused_before_a_data_directory_is_made(self):
        # With the owner role named, an empty administration or owner pair used to fall back to the runtime role (a superuser with the
        # runtime role's password) or to an empty owner password that made the init script fail halfway: a data directory whose init
        # failed is not initialised again, and the backend could not log in. The compose file cannot say so with a `:?` (it must stay
        # valid for every Compose v2), so the entrypoint of the postgres service does, before initdb, and names the variable.
        for missing in ("DB_ADMIN_USERNAME", "DB_ADMIN_PASSWORD", "DB_OWNER_PASSWORD"):
            result = self.run_preflight(**{missing: ""})
            self.assertNotEqual(result.returncode, 0, f"{missing} empty was accepted")
            self.assertIn(missing, result.stderr)
        ok = self.run_preflight()
        self.assertEqual(ok.returncode, 0, ok.stderr)

    def test_a_shared_role_name_or_password_is_refused_before_a_data_directory_is_made(self):
        shared = secrets.token_hex(16)
        for override, name in (
            ({"DB_OWNER_PASSWORD": shared, "DB_ADMIN_PASSWORD": shared}, "DB_PASSWORD, DB_OWNER_PASSWORD and DB_ADMIN_PASSWORD"),
            ({"DB_ADMIN_USERNAME": "blog_owner"}, "DB_USERNAME, DB_OWNER_USERNAME and DB_ADMIN_USERNAME"),
        ):
            result = self.run_preflight(**override)
            self.assertNotEqual(result.returncode, 0, name)
            self.assertIn(name, result.stderr)
            self.assertNotIn(shared, result.stderr + result.stdout)

    def test_an_administration_role_without_an_owner_role_is_refused(self):
        result = self.run_preflight(DB_OWNER_USERNAME="", DB_OWNER_PASSWORD="")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DB_OWNER_USERNAME", result.stderr)

    def test_postgres_starts_through_the_preflight_and_keeps_the_images_command(self):
        service = self.new["postgres"]
        self.assertEqual(service["entrypoint"], ["sh", "/usr/local/bin/postgres-preflight.sh"])
        self.assertEqual(service["command"], ["postgres"], "setting entrypoint clears the image's command")
        mounts = {v["target"]: v for v in service["volumes"]}
        self.assertTrue(mounts["/usr/local/bin/postgres-preflight.sh"]["read_only"])

    def test_an_install_from_before_the_three_roles_is_unchanged(self):
        postgres, backend = self.old["postgres"]["environment"], self.old["backend"]["environment"]
        self.assertEqual(postgres["POSTGRES_USER"], "blog", "the superuser role must stay the one it was")
        self.assertEqual(postgres["POSTGRES_PASSWORD"], backend["DB_PASSWORD"])
        self.assertEqual(postgres["OWNER_DB_USER"], "", "an empty owner role makes deploy/postgres-init do nothing")
        self.assertEqual(postgres["OWNER_DB_PASSWORD"], "")
        self.assertEqual((postgres["ADMIN_DB_USER_GIVEN"], postgres["ADMIN_DB_PASSWORD_GIVEN"]), ("", ""))
        self.assertEqual(backend["DB_USERNAME"], "blog")
        self.assertEqual(backend["SPRING_FLYWAY_USER"], "blog")
        self.assertEqual(backend["SPRING_FLYWAY_PASSWORD"], backend["DB_PASSWORD"])

    def test_the_init_folder_is_mounted_read_only_and_the_passwords_are_environment_only(self):
        mounts = {v["target"]: v for v in self.new["postgres"]["volumes"]}
        self.assertTrue(mounts["/docker-entrypoint-initdb.d"]["read_only"])
        self.assertEqual(mounts["/docker-entrypoint-initdb.d"]["type"], "bind")
        for name in ("10-roles.sh", "roles.psql"):
            self.assertTrue((ROOT / "deploy" / "postgres-init" / name).is_file(), name)

    def test_init_env_and_the_template_name_every_secret_of_the_roles(self):
        template = (ROOT / ".env.example").read_text(encoding="utf-8")
        for key in ("DB_USERNAME", "DB_PASSWORD", "DB_OWNER_USERNAME", "DB_OWNER_PASSWORD", "DB_ADMIN_USERNAME", "DB_ADMIN_PASSWORD"):
            self.assertRegex(template, rf"(?m)^{key}=", key)
        for script in ("init-env.sh", "init-env.ps1"):
            text = (ROOT / "scripts" / script).read_text(encoding="utf-8")
            for key in ("DB_PASSWORD", "DB_OWNER_PASSWORD", "DB_ADMIN_PASSWORD"):
                self.assertIn(key, text, f"{script} does not write {key}")


def nested_required_variables(text):
    """Every `${NAME:?...}` or `${NAME?...}` that sits inside another `${...}` of the compose file (comment lines are skipped)."""
    found = []
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue
        depth, index = 0, 0
        while index < len(line):
            if line.startswith("${", index):
                match = re.match(r"\$\{[A-Za-z_][A-Za-z0-9_]*:?\?", line[index:])
                if match and depth > 0:
                    found.append((number, line.strip()))
                depth += 1
                index += 2
                continue
            if line[index] == "}" and depth > 0:
                depth -= 1
            index += 1
    return found


class ComposeFileShape(unittest.TestCase):
    """Properties of docker-compose.yml that do not depend on the Compose version that reads it."""

    def test_a_required_variable_is_never_nested_inside_another_interpolation(self):
        # Compose before v2.40 (compose-go before its lazy default evaluation) fills in the default or the alternative text of a
        # variable first and only then checks whether the variable is set, so `${A:-${B:?...}}` fails on an install that sets A
        # but not B. A single-role .env then stopped every docker compose command (backup, logs, exec), not only `up`.
        self.assertEqual(nested_required_variables(COMPOSE.read_text(encoding="utf-8")), [])

    def test_the_detector_sees_the_nested_shapes(self):
        for line in ("X: ${A:-${B:?m}}", "X: ${A:+${B:?m}}", "X: ${A:-${C:-d}${B:?m}}", "X: ${A:-${B?m}}"):
            self.assertTrue(nested_required_variables(line), line)
        for line in ("X: ${A:?m}", "X: ${A:-${B}}", "X: ${A:?m}${B:?m}", "# X: ${A:-${B:?m}}"):
            self.assertEqual(nested_required_variables(line), [], line)


# Docker Compose v2.33, which evaluates the default of a variable eagerly (the oldest shape the compose file must keep working with).
OLDER_COMPOSE_IMAGE = "docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c"


@unittest.skipUnless(docker_ok(), "needs the docker CLI with compose")
class OlderComposeV2(unittest.TestCase):
    """`docker compose config` of an older Compose v2 (the docker CLI image; it only reads the files, it needs no daemon)."""

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="older-compose-")
        cls.addClassCleanup(shutil.rmtree, cls.directory, ignore_errors=True)
        probe = subprocess.run(["docker", "run", "--rm", OLDER_COMPOSE_IMAGE, "docker", "compose", "version"],
                               capture_output=True, text=True)
        if probe.returncode != 0:
            raise unittest.SkipTest("the older docker CLI image is not available: " + probe.stderr.strip()[:200])

    def config(self, roles, **extra):
        env = env_file(self.directory, roles=roles, **extra)
        return subprocess.run(
            ["docker", "run", "--rm", "-v", f"{ROOT}:/w:ro", "-v", f"{env}:/env/.env.test:ro", "-w", "/w", OLDER_COMPOSE_IMAGE,
             "docker", "compose", "--env-file", "/env/.env.test", "-f", "docker-compose.yml", "config", "--format", "json"],
            capture_output=True, text=True)

    def test_a_single_role_env_renders(self):
        result = self.config(roles=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["services"]["postgres"]["environment"]["OWNER_DB_USER"], "")

    def test_a_three_role_env_renders(self):
        result = self.config(roles=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["services"]["postgres"]["environment"]["POSTGRES_USER"], "blog_admin")

    def test_a_half_filled_three_role_env_still_renders_so_that_logs_and_backups_keep_working(self):
        # The all-or-nothing rule is the postgres entrypoint's; it must never stop docker compose exec, logs or ps.
        result = self.config(roles=True, DB_ADMIN_PASSWORD="")
        self.assertEqual(result.returncode, 0, result.stderr)


class DockerfileHardening(unittest.TestCase):
    """Static checks of the runtime stages (the images themselves are checked in the stack test below)."""

    @staticmethod
    def runtime_stage(path):
        text = path.read_text(encoding="utf-8")
        return text[text.index("AS runtime"):]

    def test_the_frontend_application_tree_is_not_owned_by_the_runtime_user(self):
        stage = self.runtime_stage(FRONTEND_DOCKERFILE)
        copies = [line for line in stage.splitlines() if line.startswith("COPY ")]
        self.assertGreaterEqual(len(copies), 3)
        for line in copies:
            self.assertNotIn("--chown", line, line)

    def test_the_frontend_cache_is_the_one_writable_path(self):
        stage = self.runtime_stage(FRONTEND_DOCKERFILE)
        self.assertRegex(stage, r"mkdir -p /app/\.next/cache && chown nextjs:nodejs /app/\.next/cache")
        self.assertEqual(len(re.findall(r"chown ", stage)), 1)

    def test_the_frontend_image_knows_the_address_it_was_built_for_and_checks_it_before_it_starts(self):
        stage = self.runtime_stage(FRONTEND_DOCKERFILE)
        self.assertRegex(stage, r"(?m)^ARG NEXT_PUBLIC_SITE_URL=")
        self.assertRegex(stage, r"(?m)^ENV BAKED_SITE_URL=\$NEXT_PUBLIC_SITE_URL$")
        self.assertIn("COPY --from=build /app/scripts/start-check.mjs ./start-check.mjs", stage)
        self.assertIn("COPY --from=build /app/scripts/api-base-url-rule.mjs ./api-base-url-rule.mjs", stage)
        self.assertRegex(stage, r'(?m)^CMD \["node", "start-check\.mjs"\]$')

    def test_the_frontend_build_stage_removes_the_prerendered_pages_that_revalidate_from_the_shipped_tree(self):
        # The image build has no backend, so those pages hold the neutral default content, and Next 16.4 serves such a copy once after
        # every restart. The runtime tree is read-only, so the server cannot remove them at start: the build stage does, after the build.
        text = FRONTEND_DOCKERFILE.read_text(encoding="utf-8")
        build = text[text.index("AS build"):text.index("AS runtime")]
        self.assertIn("RUN node scripts/clear-prerendered-pages.mjs .next/standalone/.next", build)
        self.assertLess(build.index("RUN npm run build"), build.index("clear-prerendered-pages.mjs"), "the step must run after next build")
        self.assertNotIn("clear-prerendered-pages", text[text.index("AS runtime"):], "the runtime stage cannot write the tree")
        self.assertTrue((ROOT / "frontend" / "scripts" / "clear-prerendered-pages.mjs").is_file())
        self.assertRegex((ROOT / "frontend" / "lib" / "runtime-cache.ts").read_text(encoding="utf-8"),
                         r"from '\.\./scripts/clear-prerendered-pages\.mjs'")

    def test_both_images_run_as_a_non_root_user(self):
        self.assertRegex(self.runtime_stage(FRONTEND_DOCKERFILE), r"(?m)^USER nextjs$")
        self.assertRegex(self.runtime_stage(BACKEND_DOCKERFILE), r"(?m)^USER blog$")

    def test_the_runtime_images_drop_the_package_manager(self):
        self.assertIn("apk --purge del apk-tools", self.runtime_stage(FRONTEND_DOCKERFILE))
        self.assertIn("apk --purge del apk-tools", self.runtime_stage(BACKEND_DOCKERFILE))
        stage = self.runtime_stage(FRONTEND_DOCKERFILE)
        for path in ("/usr/local/lib/node_modules/npm", "/usr/local/lib/node_modules/corepack", "/usr/local/bin/npx", "/opt/yarn-"):
            self.assertIn(path, stage)


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def run(*command, **kwargs):
    return subprocess.run(command, capture_output=True, text=True, **kwargs)


_images_built = False


def build_images():
    """Builds the two images once per run, with the tags the compose file gives them (the image tests below run before the stack test
    and need them; CONTAINER_STACK_NO_BUILD=1 says they are already there)."""
    global _images_built
    if _images_built or os.environ.get("CONTAINER_STACK_NO_BUILD") == "1":
        return
    directory = tempfile.mkdtemp(prefix="hardening-build-")
    try:
        env = env_file(directory, roles=True)
        built = run("docker", "compose", "-p", "hardening-build", "--env-file", str(env), "-f", str(COMPOSE), "build", "backend", "frontend",
                    cwd=ROOT, timeout=2400)
        if built.returncode != 0:
            raise AssertionError(f"the images did not build:\n{built.stdout[-3000:]}{built.stderr[-3000:]}")
    finally:
        shutil.rmtree(directory, ignore_errors=True)
    _images_built = True


@unittest.skipUnless(os.environ.get("CONTAINER_STACK_DOCKER") == "1" and docker_ok(), "set CONTAINER_STACK_DOCKER=1 (builds and starts the stack)")
class StackInDocker(unittest.TestCase):
    """Builds and starts the whole stack with compose and inspects the real containers."""

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="hardening-stack-")
        cls.project = f"hardening{os.getpid()}"
        cls.port = free_port()
        cls.meili_port = free_port()
        cls.env = env_file(cls.directory, roles=True, SITE_PORT=str(cls.port))
        cls.addClassCleanup(shutil.rmtree, cls.directory, ignore_errors=True)
        cls.addClassCleanup(cls.teardown)
        build_images()
        up = ["--build"] if os.environ.get("CONTAINER_STACK_NO_BUILD") != "1" else []
        started = cls.compose("--profile", "search", "up", "-d", "--wait", "--wait-timeout", "420", *up, timeout=2400)
        if started.returncode != 0:
            logs = cls.compose("--profile", "search", "logs", "--tail", "60")
            raise AssertionError(f"the stack did not become healthy:\n{started.stderr}\n{logs.stdout}{logs.stderr}")

    @classmethod
    def compose(cls, *args, timeout=600, stdin=None):
        command = ["docker", "compose", "-p", cls.project, "--env-file", str(cls.env), "-f", str(COMPOSE), *args]
        return run(*command, cwd=ROOT, timeout=timeout, input=stdin)

    @classmethod
    def teardown(cls):
        cls.compose("--profile", "search", "down", "-v", "--remove-orphans")

    def inspect(self, service):
        ids = self.compose("--profile", "search", "ps", "-q", service).stdout.split()
        self.assertEqual(len(ids), 1, service)
        return json.loads(run("docker", "inspect", ids[0]).stdout)[0]

    def exec(self, service, *command, stdin=None):
        return self.compose("--profile", "search", "exec", "-T", service, *command, stdin=stdin)

    def sql(self, statement):
        """Runs a statement as the superuser of the database container (the statement goes in through stdin, so no quoting)."""
        result = self.exec("postgres", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -At -v ON_ERROR_STOP=1 -f -', stdin=statement)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def test_the_settings_reached_the_containers(self):
        for name in HARDENED + ("postgres",):
            host = self.inspect(name)["HostConfig"]
            self.assertIs(host["ReadonlyRootfs"], True, name)
            self.assertIn("no-new-privileges:true", host["SecurityOpt"], name)
            self.assertIn("ALL", host["CapDrop"], name)
            self.assertGreater(host["PidsLimit"], 0, name)

    def test_the_site_answers_and_every_service_is_healthy(self):
        for name in HARDENED + ("postgres",):
            self.assertEqual(self.inspect(name)["State"]["Health"]["Status"], "healthy", name)
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/", timeout=30) as response:
            self.assertEqual(response.status, 200)

    def test_the_backend_runs_as_a_role_that_can_only_read_and_write_rows(self):
        self.assertEqual(self.sql("SELECT usename FROM pg_stat_activity WHERE datname = 'blog' AND usename = 'blog_app' LIMIT 1"), "blog_app")
        self.assertEqual(self.sql("SELECT rolsuper FROM pg_roles WHERE rolname = 'blog_app'"), "f")
        self.assertEqual(self.sql("SELECT string_agg(DISTINCT tableowner, ',') FROM pg_tables WHERE schemaname = 'public'"), "blog_owner")
        logs = self.compose("--profile", "search", "logs", "backend")
        self.assertNotIn("connects to PostgreSQL as a superuser", logs.stdout + logs.stderr)

    def test_the_frontend_cannot_resolve_or_reach_the_database(self):
        script = "const net=require('net');const s=net.connect({host:'postgres',port:5432});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),4000)"
        self.assertEqual(self.exec("frontend", "node", "-e", script).returncode, 0, "the frontend opened a connection to postgres")

    def test_the_frontend_code_cannot_be_rewritten_and_the_cache_can_be_written(self):
        self.assertNotEqual(self.exec("frontend", "sh", "-c", "touch /app/server.js").returncode, 0)
        self.assertNotEqual(self.exec("frontend", "sh", "-c", "touch /app/.next/static/x").returncode, 0)
        self.assertEqual(self.exec("frontend", "sh", "-c", "touch /app/.next/cache/probe && touch /tmp/probe").returncode, 0)

    def wait_healthy(self, service, seconds=120):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.inspect(service)["State"].get("Health", {}).get("Status") == "healthy":
                return
            time.sleep(2)
        self.fail(f"{service} did not become healthy again")

    def fetch(self, path, accept="*/*"):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers={"Accept": accept})
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.headers, response.read()

    def test_a_rendered_post_and_an_optimized_image_are_cached_without_a_failed_write(self):
        """The application tree is read-only and the image cache is a tmpfs: Next must not log a failed write for either.

        A post page is incremental static rendering (revalidate = 300): the built-in cache would write it under .next/server/app, which
        is root-owned. An optimized image is written to the image cache, a tmpfs whose size the cache limit has to fit."""
        media = str(uuid.uuid4())
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        self.sql(
            f"INSERT INTO media (id, content_type, width, height, byte_size, sha256) "
            f"SELECT '{media}', 'image/png', 1, 1, length(d), encode(sha256(d), 'hex') FROM (SELECT decode('{png}', 'base64') AS d) bytes; "
            f"INSERT INTO media_content (media_id, data) VALUES ('{media}', decode('{png}', 'base64')); "
            f"INSERT INTO posts (title, slug, content, status, author_id, published_at, language) "
            f"SELECT 'Cache probe', 'cache-probe', 'A post for the cache probe.', 'PUBLISHED', id, now(), 'en' FROM users ORDER BY created_at LIMIT 1;"
        )

        for attempt in ("first", "second"):
            status, headers, body = self.fetch("/posts/cache-probe")
            self.assertEqual(status, 200, attempt)
            self.assertIn(b"Cache probe", body, attempt)
        self.assertEqual(headers.get("x-nextjs-cache"), "HIT", "the second request for the post was not served from the cache")

        image = f"/_next/image?url=%2Fmedia%2F{media}.png&w=64&q=75"
        for attempt in ("first", "second"):
            status, headers, body = self.fetch(image, accept="image/webp")
            self.assertEqual(status, 200, attempt)
            self.assertGreater(len(body), 0, attempt)
        self.assertEqual(headers.get("x-nextjs-cache"), "HIT", "the second request for the image was not served from the cache")
        self.assertEqual(self.exec("frontend", "sh", "-c", "ls /app/.next/cache/images | wc -l").stdout.strip(), "1")

        logs = self.compose("--profile", "search", "logs", "frontend")
        text = logs.stdout + logs.stderr
        for message in ("Failed to update prerender cache", "Failed to write image to cache", "EROFS", "ENOSPC"):
            self.assertNotIn(message, text)

        # docs/BACKUP-AND-RESTORE.md and docs/ARCHITECTURE.md: a restart empties the image cache (a tmpfs) and the page cache (memory).
        self.assertEqual(self.compose("--profile", "search", "restart", "frontend").returncode, 0)
        self.wait_healthy("frontend")
        self.assertEqual(self.exec("frontend", "sh", "-c", "ls /app/.next/cache/images 2>/dev/null | wc -l").stdout.strip(), "0")
        self.assertNotEqual(self.fetch(image, accept="image/webp")[1].get("x-nextjs-cache"), "HIT")

    def test_the_first_request_after_a_restart_is_rendered_not_served_from_the_build(self):
        """The image build has no backend: a page of it that revalidates holds the neutral default content. Next 16.4 would serve that
        copy once, stale, after a restart, and the server cannot remove it (read-only tree), so the Dockerfile removes it at build."""
        self.assertEqual(self.compose("--profile", "search", "restart", "frontend").returncode, 0)
        self.wait_healthy("frontend")
        # Every one of these pages revalidates and was prerendered at build time before the step existed.
        for path in ("/bookmarks", "/newsletter", "/case-studies"):
            status, headers, _ = self.fetch(path)
            self.assertEqual(status, 200, path)
            self.assertNotIn(headers.get("x-nextjs-cache"), ("HIT", "STALE"), f"{path} was served from a copy made at build time")


    def test_the_backend_jar_cannot_be_rewritten_and_the_data_directory_can_be_written(self):
        self.assertNotEqual(self.exec("backend", "sh", "-c", "touch /app/app.jar").returncode, 0)
        self.assertEqual(self.exec("backend", "sh", "-c", "touch /data/probe && rm /data/probe && touch /tmp/probe").returncode, 0)


@unittest.skipUnless(os.environ.get("CONTAINER_STACK_DOCKER") == "1" and docker_ok(), "set CONTAINER_STACK_DOCKER=1 (needs the built images)")
class ImagesInDocker(unittest.TestCase):
    """The structure of the two runtime images, from the image alone (no compose settings): owner of the code, tools left."""

    FRONTEND = os.environ.get("FRONTEND_IMAGE", "blog-engine-frontend:local")
    BACKEND = os.environ.get("BACKEND_IMAGE", "blog-engine-backend:local")

    @classmethod
    def setUpClass(cls):
        build_images()

    def sh(self, image, script):
        return run("docker", "run", "--rm", "--entrypoint", "sh", image, "-c", script)

    def test_the_frontend_tree_belongs_to_root_and_only_the_cache_is_writable(self):
        self.assertEqual(self.sh(self.FRONTEND, "stat -c %U /app/server.js").stdout.strip(), "root")
        self.assertEqual(self.sh(self.FRONTEND, "id -un").stdout.strip(), "nextjs")
        self.assertNotEqual(self.sh(self.FRONTEND, "touch /app/server.js").returncode, 0)
        self.assertNotEqual(self.sh(self.FRONTEND, "touch /app/node_modules/x").returncode, 0)
        self.assertEqual(self.sh(self.FRONTEND, "test -w /app/.next/cache").returncode, 0)

    def test_the_frontend_image_holds_no_prerendered_page_that_revalidates(self):
        script = (
            "const fs=require('fs');const m=JSON.parse(fs.readFileSync('/app/.next/prerender-manifest.json','utf8'));"
            "const left=[];for(const [r,i] of Object.entries(m.routes)){"
            "if(i.routeType!=='page'||typeof i.initialRevalidateSeconds!=='number')continue;"
            "const b='/app/.next/server/app'+(r==='/'?'/index':r);"
            "for(const e of ['.html','.rsc','.meta','.segments'])if(fs.existsSync(b+e))left.push(r+e)}"
            "console.log(JSON.stringify({routes:Object.keys(m.routes).length,left}))"
        )
        result = run("docker", "run", "--rm", "--entrypoint", "node", self.FRONTEND, "-e", script)
        self.assertEqual(result.returncode, 0, result.stderr)
        found = json.loads(result.stdout)
        self.assertGreater(found["routes"], 0, "the image has no prerender manifest to check")
        self.assertEqual(found["left"], [], "the image still carries a copy of a revalidating page made without a backend")

    def test_the_frontend_has_no_package_manager_or_relay_tools(self):
        paths = ["/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/yarn", "/usr/local/bin/yarnpkg",
                 "/usr/local/bin/corepack", "/usr/local/lib/node_modules/npm", "/sbin/apk", "/usr/bin/nc", "/usr/bin/wget"]
        for path in paths:
            self.assertEqual(self.sh(self.FRONTEND, f"test ! -e {path} && test ! -L {path}").returncode, 0, path)
        self.assertEqual(self.sh(self.FRONTEND, "node -e \"require('crypto').randomBytes(8)\"").returncode, 0, "node must still run")

    def run_to_exit(self, name, image, environment, seconds):
        """Runs a container that is expected to exit by itself. A container that keeps running is a failure, and it is removed by name."""
        command = ["docker", "run", "--rm", "--name", name]
        for key, value in environment.items():
            command += ["-e", f"{key}={value}"]
        try:
            return run(*command, image, timeout=seconds)
        except subprocess.TimeoutExpired:
            self.fail(f"{name} was still running after {seconds} seconds: it should have refused to start")
        finally:
            run("docker", "rm", "-f", name)

    def test_the_frontend_refuses_to_start_on_an_api_address_it_would_reject_on_every_page(self):
        refused = self.run_to_exit(f"hardening-api-url-{os.getpid()}", self.FRONTEND,
                                   {"NODE_ENV": "production", "API_BASE_URL": "http://10.0.0.5:8080"}, 120)
        self.assertEqual(refused.returncode, 1, refused.stdout)
        self.assertIn("API_ALLOW_PLAINTEXT", refused.stderr)

    def test_the_backend_jar_belongs_to_root_and_the_data_directory_is_writable(self):
        self.assertEqual(self.sh(self.BACKEND, "stat -c %U /app/app.jar").stdout.strip(), "root")
        self.assertNotEqual(self.sh(self.BACKEND, "touch /app/app.jar").returncode, 0)
        self.assertEqual(self.sh(self.BACKEND, "touch /data/probe").returncode, 0)

    def test_the_backend_refuses_an_unverified_remote_database_before_it_opens_a_connection(self):
        """The link check must run before Flyway and the pool: a connection attempt to the unresolvable host would show in the output."""
        environment = {
            "SITE_URL": "https://example.org",
            "JWT_SECRET": secrets.token_hex(32),
            "MFA_ENCRYPTION_KEY": base64.b64encode(os.urandom(32)).decode("ascii"),
            "VIEWS_TOKEN": secrets.token_hex(16),
            "CLIENT_IP_TOKEN": secrets.token_hex(16),
            "DB_HOST": "database.invalid",
        }
        result = self.run_to_exit(f"hardening-db-link-{os.getpid()}", self.BACKEND, environment, 240)
        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("DB_SSLMODE", output)
        self.assertIn("database.invalid", output)
        # The refusal is the failure of the data source bean itself, so nothing was asked of the database before it.
        self.assertTrue("Error creating bean with name 'dataSource'" in output, "the check did not fire when the data source was created")
        for marker in ("UnknownHostException", "PSQLException", "HikariPool", "Flyway Community", "Migrating schema"):
            self.assertFalse(marker in output, f"the backend tried to reach the database before refusing ({marker})")

    def test_the_backend_has_no_package_manager_or_netcat(self):
        for path in ("/sbin/apk", "/usr/bin/nc"):
            self.assertEqual(self.sh(self.BACKEND, f"test ! -e {path} && test ! -L {path}").returncode, 0, path)
        # wget stays on purpose: the compose healthcheck of the backend uses it.
        self.assertEqual(self.sh(self.BACKEND, "command -v wget").returncode, 0)
        self.assertEqual(self.sh(self.BACKEND, "java -version").returncode, 0)


if __name__ == "__main__":
    unittest.main()
