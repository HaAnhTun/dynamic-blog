"""Guard for the reverse proxy examples in deploy/ (offline, standard library only).

`deploy/nginx.conf.example` and `deploy/Caddyfile.example` are what an operator copies in front of the compose stack. Two things
about them are security properties and must not drift:

- Access logs never carry a query string. A search term (`/search?q=...`), a newsletter token or a page cached from before a fix
  would otherwise sit in the proxy log with the reader's address. The nginx format `no_query` logs `$uri` and no referer (the
  referer of a click on a search result is the search URL), every server block uses it (or `access_log off`), and the Caddy
  example filters the query out of the one log Caddy writes by default (the error log of a failed upstream names the request).
- The nginx TLS floor is stated by the file itself (TLS 1.2 and 1.3, no session tickets, no version in the `Server` header), not by
  whatever the distribution's nginx defaults to.

The static checks below read the files with a small nginx configuration parser. The last class starts a real nginx and a real Caddy
in Docker and is skipped unless DEPLOY_EXAMPLES_DOCKER=1 (it needs the Docker daemon, `openssl` and network access for the images).

run: python scripts/test_deploy_examples.py
     DEPLOY_EXAMPLES_DOCKER=1 python scripts/test_deploy_examples.py
"""
import os
import re
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NGINX = ROOT / "deploy" / "nginx.conf.example"
CADDY = ROOT / "deploy" / "Caddyfile.example"

# Pinned only in spirit: the integration class uses the current stable images, because it checks configuration syntax, not a release.
NGINX_IMAGE = "nginx:stable-alpine"
CADDY_IMAGE = "caddy:2-alpine"

# Variables of a log format that can carry the query string or a URL that holds one.
QUERY_VARIABLES = re.compile(r"\$(request|request_uri|args|query_string|is_args|http_referer|http_x_original_url)\b")


NEWLINE = chr(10)


class Directive:
    """One nginx directive: a name, its arguments and, for a block, the directives inside it."""

    def __init__(self, name, args, children=None):
        self.name = name
        self.args = args
        self.children = children

    def __repr__(self):
        return f"Directive({self.name!r}, {self.args!r})"


def tokenize(text):
    """Tokens as (kind, value): kind is "word" for a word or a quoted string and "punct" for `{`, `}` and `;`. Comments are dropped."""
    tokens = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
        elif c == "#":
            while i < n and text[i] != NEWLINE:
                i += 1
        elif c in "{};":
            tokens.append(("punct", c))
            i += 1
        elif c in "\"'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            tokens.append(("word", text[i + 1 : j]))
            i = j + 1
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in "{};":
                j += 1
            tokens.append(("word", text[i:j]))
            i = j
    return tokens


def parse(text):
    """The directives of an nginx configuration as a tree."""
    tokens = tokenize(text)
    position = 0

    def block():
        nonlocal position
        found = []
        while position < len(tokens):
            if tokens[position] == ("punct", "}"):
                position += 1
                return found
            words = []
            while tokens[position][0] == "word":
                words.append(tokens[position][1])
                position += 1
            ender = tokens[position][1]
            position += 1
            if ender == ";":
                found.append(Directive(words[0], words[1:]))
            else:
                found.append(Directive(words[0], words[1:], block()))
        return found

    return block()


def directives(nodes, name):
    return [node for node in nodes if node.name == name]


def effective(chain, name):
    """The directives called `name` that apply at the innermost level of `chain` (a list of directive lists, outermost first).

    access_log, ssl_protocols and the others inherit from the enclosing level only when the level itself does not set them.
    """
    for level in reversed(chain):
        found = directives(level, name)
        if found:
            return found
    return []


def servers(tree):
    """Every `server` block, found in the http level of a conf.d file (the file is included there)."""
    return directives(tree, "server")


def listens_on_443_ssl(server):
    return any("443" in " ".join(d.args) and "ssl" in d.args for d in directives(server.children, "listen"))


def effective_log_formats(tree, server_node, location=None):
    """The formats the access logs of a server or one of its locations write with ('off' counts as such)."""
    chain = [tree, server_node.children] + ([location.children] if location else [])
    return [d.args for d in effective(chain, "access_log")]


def walk_locations(server_node):
    stack = list(directives(server_node.children, "location"))
    while stack:
        node = stack.pop()
        yield node
        stack.extend(directives(node.children, "location"))


class NginxExample(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = NGINX.read_text(encoding="utf-8")
        cls.tree = parse(cls.text)

    def test_the_file_parses_into_servers(self):
        self.assertEqual(len(servers(self.tree)), 3, "port 80, www and the main host, nothing else")

    def test_the_no_query_format_has_nothing_that_can_carry_a_query(self):
        formats = [d for d in directives(self.tree, "log_format") if d.args and d.args[0] == "no_query"]
        self.assertEqual(len(formats), 1, "exactly one log_format no_query")
        body = " ".join(formats[0].args[1:])
        self.assertIn("$uri", body)
        self.assertIsNone(QUERY_VARIABLES.search(body), f"the format writes a variable that holds the query string: {body}")

    def test_every_server_writes_its_access_log_without_the_query(self):
        for server in servers(self.tree):
            logs = effective_log_formats(self.tree, server)
            names = " ".join(d.args[0] for d in directives(server.children, "server_name"))
            self.assertTrue(logs, f"server {names} has no access_log of its own: it would use the distribution's default format")
            for args in logs:
                self.assertTrue(args == ["off"] or args[1:2] == ["no_query"], f"server {names} logs with {args}")

    def test_no_location_falls_back_to_a_log_format_with_the_query(self):
        for server in servers(self.tree):
            for location in walk_locations(server):
                for args in effective_log_formats(self.tree, server, location):
                    self.assertTrue(
                        args == ["off"] or args[1:2] == ["no_query"], f"location {location.args} logs with {args}")

    def test_the_oauth_callback_is_not_logged_at_all(self):
        callbacks = [
            loc
            for server in servers(self.tree)
            for loc in walk_locations(server)
            if loc.args == ["=", "/api/auth/github/callback"]
        ]
        self.assertTrue(callbacks, "no location for /api/auth/github/callback")
        for location in callbacks:
            self.assertEqual([d.args for d in directives(location.children, "access_log")], [["off"]])

    def test_the_text_does_not_log_the_request_line_or_the_referer_anywhere(self):
        for directive in directives(self.tree, "log_format"):
            if directive.args[0] != "no_query":
                self.fail(f"another log_format ({directive.args[0]}) in a file that is meant to keep queries out of the log")


class NginxTls(unittest.TestCase):
    """Issue 098: the protocol floor is in the file, not in the distribution's defaults."""

    @classmethod
    def setUpClass(cls):
        cls.tree = parse(NGINX.read_text(encoding="utf-8"))
        cls.tls_servers = [s for s in servers(cls.tree) if listens_on_443_ssl(s)]

    def test_there_are_two_tls_servers(self):
        self.assertEqual(len(self.tls_servers), 2)

    def setting(self, server, name):
        return [d.args for d in effective([self.tree, server.children], name)]

    def test_only_tls_1_2_and_1_3(self):
        for server in self.tls_servers:
            self.assertEqual(self.setting(server, "ssl_protocols"), [["TLSv1.2", "TLSv1.3"]])

    def test_session_tickets_are_off(self):
        for server in self.tls_servers:
            self.assertEqual(self.setting(server, "ssl_session_tickets"), [["off"]])

    def test_the_server_version_is_not_announced(self):
        for server in self.tls_servers:
            self.assertEqual(self.setting(server, "server_tokens"), [["off"]])

    def test_the_client_chooses_the_cipher_among_the_strong_ones(self):
        for server in self.tls_servers:
            self.assertEqual(self.setting(server, "ssl_prefer_server_ciphers"), [["off"]])

    def test_a_session_cache_is_set_and_ocsp_stapling_is_not_asked_for(self):
        for server in self.tls_servers:
            self.assertTrue(self.setting(server, "ssl_session_cache"))
            self.assertEqual(self.setting(server, "ssl_stapling"), [], "Let's Encrypt no longer runs OCSP: stapling has nothing to staple")

    def test_the_tls_settings_are_not_at_http_level(self):
        # The distribution's nginx.conf sets ssl_protocols at http level; a second one there is "directive is duplicate".
        for name in ("ssl_protocols", "ssl_prefer_server_ciphers", "ssl_session_tickets", "ssl_session_timeout"):
            self.assertEqual(directives(self.tree, name), [], f"{name} at http level would clash with nginx.conf")


class CaddyExample(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = CADDY.read_text(encoding="utf-8")
        cls.code = "\n".join(line.split("#", 1)[0] for line in cls.text.splitlines())

    def test_the_default_log_removes_the_query_from_the_uri(self):
        # Caddy writes no access log without a `log` directive, but its error log (a failed upstream) names the request with its uri.
        match = re.search(r"^\{\s*$(.*?)^\}\s*$", self.code, re.S | re.M)
        self.assertIsNotNone(match, "no global options block")
        options = match.group(1)
        self.assertRegex(options, r"(?m)^\s*log\s*\{")
        self.assertRegex(options, r"format\s+filter")
        self.assertRegex(options, r"request>uri\s+regexp\s+\\\?\.\*")
        self.assertRegex(options, r"request>headers>Referer\s+delete")

    def test_a_site_log_directive_has_the_same_filter(self):
        site = self.code.split("example.com {", 1)[-1]
        if re.search(r"(?m)^\s*log\s*(\{|$)", site):
            self.assertRegex(site, r"request>uri\s+regexp")

    def test_one_time_tokens_stay_out_of_any_access_log(self):
        self.assertIn("log_skip @private", self.code)
        for path in ("/api/auth/github/callback", "/newsletter/*", "/api/newsletter/*", "/admin/login"):
            self.assertIn(path, self.code)


def docker_available():
    if shutil.which("docker") is None or shutil.which("openssl") is None:
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


DOCKER_TESTS = os.environ.get("DEPLOY_EXAMPLES_DOCKER") == "1" and docker_available()
DOCKER_ENV = {**os.environ, "MSYS_NO_PATHCONV": "1"}


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def run(*command, **kwargs):
    return subprocess.run(command, capture_output=True, text=True, env=DOCKER_ENV, **kwargs)


def mount_path(path):
    return str(path).replace(chr(92), "/")


def https_get(port, path, headers=None):
    """A GET to https://localhost:<port> (the name matters: Caddy picks its certificate by SNI, which an IP address does not send)."""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    request = urllib.request.Request(f"https://localhost:{port}{path}", headers=headers or {})
    try:
        with urllib.request.urlopen(request, context=context, timeout=5) as response:
            return response.status, dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers)


def wait_for_https(port, attempts=40):
    for _ in range(attempts):
        try:
            https_get(port, "/")
            return True
        except OSError:
            time.sleep(0.5)
    return False


@unittest.skipUnless(DOCKER_TESTS, "set DEPLOY_EXAMPLES_DOCKER=1 with Docker and openssl")
class NginxInDocker(unittest.TestCase):
    """`nginx -t` on the example, then real requests: no query in the access log, the TLS floor, no version announced."""

    @classmethod
    def setUpClass(cls):
        cls.directory = Path(tempfile.mkdtemp(prefix="deploy-nginx-"))
        cls.name = f"deploy-nginx-{os.getpid()}"
        cls.addClassCleanup(shutil.rmtree, cls.directory, ignore_errors=True)
        cls.addClassCleanup(run, "docker", "rm", "-f", cls.name)
        (cls.directory / "blog.conf").write_text(NGINX.read_text(encoding="utf-8").replace("example.com", "localhost"), encoding="utf-8")
        # A stand-in for Next on 127.0.0.1:3000 inside the same nginx, and an empty default server so the names do not clash.
        (cls.directory / "upstream.conf").write_text(
            "server { listen 127.0.0.1:3000; access_log off; location / { return 200 'ok'; } }\n", encoding="utf-8")
        (cls.directory / "default.conf").write_text("", encoding="utf-8")
        # The certificate at the paths of the example, self signed.
        certs = cls.directory / "certs"
        certs.mkdir()
        made = run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
                   "-keyout", mount_path(certs / "privkey.pem"), "-out", mount_path(certs / "fullchain.pem"))
        if made.returncode != 0:
            raise unittest.SkipTest(f"openssl cannot make a certificate: {made.stderr.strip()}")
        cls.port = free_port()
        started = run(
            "docker", "run", "-d", "--name", cls.name, "-p", f"127.0.0.1:{cls.port}:443",
            "-v", f"{mount_path(cls.directory / 'blog.conf')}:/etc/nginx/conf.d/blog.conf:ro",
            "-v", f"{mount_path(cls.directory / 'upstream.conf')}:/etc/nginx/conf.d/upstream.conf:ro",
            "-v", f"{mount_path(cls.directory / 'default.conf')}:/etc/nginx/conf.d/default.conf:ro",
            "-v", f"{mount_path(certs)}:/etc/letsencrypt/live/localhost:ro",
            NGINX_IMAGE)
        if started.returncode != 0:
            raise unittest.SkipTest(f"cannot start nginx: {started.stderr.strip()}")
        if not wait_for_https(cls.port):
            raise AssertionError("nginx did not answer on TLS:\n" + run("docker", "logs", cls.name).stderr)

    def test_the_configuration_is_valid(self):
        result = run("docker", "exec", self.name, "nginx", "-t")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("[warn]", result.stderr)

    def test_a_search_query_and_its_referer_never_reach_the_access_log(self):
        for path in ("/search?q=canary123", "/api/search/suggest?q=canary123", "/newsletter/confirm?token=canary123"):
            https_get(self.port, path, {"Referer": "https://localhost/search?q=canary123"})
        time.sleep(1)
        logs = run("docker", "logs", self.name).stdout
        self.assertIn("GET /search ", logs, "the request was not logged at all: the check proves nothing")
        self.assertNotIn("canary123", logs)

    def test_the_server_does_not_announce_its_version(self):
        _, headers = https_get(self.port, "/")
        self.assertEqual(headers.get("Server"), "nginx")

    def test_tls_1_2_works_and_tls_1_1_is_refused(self):
        def connect(*flags):
            return subprocess.run(
                ["openssl", "s_client", "-connect", f"localhost:{self.port}", "-brief", *flags],
                input="", capture_output=True, text=True, timeout=30)

        self.assertEqual(connect("-tls1_2").returncode, 0)
        old = connect("-tls1_1", "-cipher", "DEFAULT:@SECLEVEL=0")
        if "no protocols available" in old.stderr:
            self.skipTest("this openssl cannot speak TLS 1.1")
        self.assertNotEqual(old.returncode, 0, old.stdout + old.stderr)
        self.assertRegex(old.stderr, r"(?i)alert|protocol|handshake")


@unittest.skipUnless(DOCKER_TESTS, "set DEPLOY_EXAMPLES_DOCKER=1 with Docker")
class CaddyInDocker(unittest.TestCase):
    """`caddy validate` on the example, then a request whose upstream is down: the error log must not name the query."""

    def test_the_example_is_valid_and_its_error_log_has_no_query(self):
        directory = Path(tempfile.mkdtemp(prefix="deploy-caddy-"))
        name = f"deploy-caddy-{os.getpid()}"
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        self.addCleanup(run, "docker", "rm", "-f", name)
        # Only the host changes; TLS comes from Caddy's own local authority for localhost instead of Let's Encrypt.
        (directory / "Caddyfile").write_text(CADDY.read_text(encoding="utf-8").replace("example.com", "localhost"), encoding="utf-8")
        mount = f"{mount_path(directory / 'Caddyfile')}:/etc/caddy/Caddyfile:ro"
        validate = run("docker", "run", "--rm", "-v", mount, CADDY_IMAGE, "caddy", "validate", "--config", "/etc/caddy/Caddyfile")
        self.assertEqual(validate.returncode, 0, validate.stderr)
        port = free_port()
        started = run("docker", "run", "-d", "--name", name, "-p", f"127.0.0.1:{port}:443", "-v", mount, CADDY_IMAGE)
        self.assertEqual(started.returncode, 0, started.stderr)
        self.assertTrue(wait_for_https(port, attempts=60), run("docker", "logs", name).stderr)
        https_get(port, "/search?q=canary123", {"Referer": "https://localhost/search?q=canary123"})
        time.sleep(1)
        logs = run("docker", "logs", name)
        both = logs.stdout + logs.stderr
        self.assertIn("http.log.error", both, "no error log line: the upstream on 127.0.0.1:3000 was reachable")
        self.assertNotIn("canary123", both)


if __name__ == "__main__":
    unittest.main()
