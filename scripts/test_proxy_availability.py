"""Guard for the availability rules of the reverse-proxy examples (offline, standard library only).

The two examples in `deploy/` are the first line against a request that costs Next more than it costs the sender, and they are the only
place that can stop one before Next does any work (docs/SECURITY.md, "Rate limits" and "Caching, and a CDN in front"):

- TRACE, TRACK and CONNECT make Next throw a 500 and write a stack trace per request (audit issue 103): both examples answer 405.
- nginx limits the rate per client address for pages, and tighter for the expensive reads (pictures, share cards, feeds, the sitemap),
  answers 429, caches pictures for an hour (by path alone: a random query string must not miss) and share cards for five minutes (what
  Next promises) so a flood for one picture is one request to Next, and does not limit or cache the built static files (audit issues 18
  and 26).

A text check on purpose: nginx and Caddy are not installed in CI. The behavior was checked once against real nginx 1.27 and Caddy 2 in
containers with a stub upstream (TRACE 405 and never forwarded; five requests for one picture reached the upstream once; 11 of 60 fast
requests for the sitemap and 193 of 400 for pages were answered, the rest with 429); `docs/DEVELOPMENT.md` has the commands.

run: python scripts/test_proxy_availability.py
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NGINX = ROOT / "deploy" / "nginx.conf.example"
CADDY = ROOT / "deploy" / "Caddyfile.example"


def without_comments(text):
    """The configuration with its `#` comments removed (a rule inside a comment is not a rule)."""
    return "\n".join(re.sub(r"(^|\s)#.*$", "", line) for line in text.splitlines())


def location_block(text, header_pattern):
    """The body of the first proxying `location` whose header matches, up to its closing brace (no nested braces in these blocks).

    The port 80 block also has a `location /` (a redirect); only a block that proxies to Next is the one meant.
    """
    for match in re.finditer(r"location\s+" + header_pattern + r"\s*\{([^{}]*)\}", text):
        if "proxy_pass" in match.group(1):
            return match.group(1)
    return None


def nginx_problems(text):
    config = without_comments(text)
    found = []
    if not re.search(r"if\s*\(\s*\$request_method\s*~\s*\^\(TRACE\|TRACK\|CONNECT\)\$\s*\)\s*\{\s*return\s+405\s*;", config):
        found.append("nginx: no `if ($request_method ~ ^(TRACE|TRACK|CONNECT)$) { return 405; }` in the main host block")
    if not re.search(r"^\s*limit_req_status\s+429\s*;", config, re.M):
        found.append("nginx: no `limit_req_status 429;`")
    zones = dict(re.findall(r"limit_req_zone\s+\$binary_remote_addr\s+zone=(\w+):\d+m\s+rate=(\d+)r/s\s*;", config))
    if not {"blog_pages", "blog_heavy"} <= set(zones):
        found.append("nginx: need a limit_req_zone for pages (blog_pages) and one for the expensive reads (blog_heavy)")
    elif int(zones["blog_heavy"]) >= int(zones["blog_pages"]):
        found.append("nginx: the zone of the expensive reads must be tighter than the zone of the pages")
    if not re.search(r"^\s*proxy_cache_path\s+\S+\s+.*keys_zone=blog_cache:\d+m.*max_size=\d+[mg]", config, re.M):
        found.append("nginx: no proxy_cache_path with a keys_zone (blog_cache) and a max_size")

    root = location_block(config, r"/")
    if root is None or "limit_req zone=blog_pages" not in root:
        found.append("nginx: `location /` does not limit_req the pages (zone blog_pages)")

    # The expensive reads that are the same for every reader: pictures, the optimizer, share cards. Each location has the same shape
    # (limited, cached, an hour or five minutes of a 200 only, the lock); what differs is the key and how long a 200 may stay.
    cached = [
        (r"/media/", "/media/", "1h", "$scheme$host$uri", "a picture is the same whatever the query string says: a random one must find the copy"),
        (r"=\s+/_next/image", "/_next/image", "1h", "$scheme$host$request_uri", "the query of the optimizer is the picture, the width and the quality"),
        (r"/api/og/", "/api/og/", "5m", "$scheme$host$uri", "a share card is promised for five minutes by Next, and a card has no query"),
    ]
    for pattern, name, valid, key, why in cached:
        heavy = location_block(config, pattern)
        if heavy is None:
            found.append(f"nginx: no location for {name}")
            continue
        for need, because in [
            ("limit_req zone=blog_heavy", "limit the rate"),
            ("proxy_cache blog_cache", "use the cache"),
            (f"proxy_cache_valid 200 {valid}", f"keep a 200 for {valid}"),
            ("proxy_ignore_headers Cache-Control Expires", "let that time apply instead of the year Next asks for"),
            ("proxy_cache_lock on", "send one request upstream for a burst of misses"),
            (f"proxy_cache_key {key}", f"use the key {key} ({why})"),
        ]:
            if need not in heavy:
                found.append(f"nginx: the location for {name} must {because} (`{need}`)")
        if re.search(r"proxy_cache_valid\s+(?!200\s)", heavy):
            found.append(f"nginx: only a 200 may be cached for {name} (errors are never kept)")

    feeds = location_block(config, r"~\s+\(\^/sitemap\\\.xml\$\|/feed\\\.xml\$\)")
    if feeds is None:
        found.append("nginx: no location for the sitemap and the feeds")
    else:
        if "limit_req zone=blog_heavy" not in feeds:
            found.append("nginx: the feeds and the sitemap must be rate limited (zone blog_heavy)")
        if "proxy_cache " in feeds:
            found.append("nginx: the feeds and the sitemap must not be cached: a withdrawn post has to leave them at once")

    static = location_block(config, r"/_next/static/")
    if static is None:
        found.append("nginx: no location for /_next/static/ (a page loads dozens of them, they must not be rate limited)")
    elif "limit_req" in static or "proxy_cache " in static:
        found.append("nginx: /_next/static/ must be neither rate limited nor cached by the example")
    return found


def caddy_problems(text):
    config = without_comments(text)
    found = []
    if not re.search(r"@badmethod\s+method\s+TRACE\s+TRACK\s+CONNECT\s+handle\s+@badmethod\s*\{\s*respond\s+405\s*\}", config):
        found.append("Caddy: no `@badmethod method TRACE TRACK CONNECT` handled with `respond 405`")
    else:
        first = re.search(r"^\s*handle\s+(\S+)", config, re.M)
        if first is None or first.group(1) != "@badmethod":
            found.append("Caddy: the 405 for TRACE must come before the other handle blocks")
    return found


class ProxyExamples(unittest.TestCase):
    def test_nginx_example_keeps_its_availability_rules(self):
        self.assertEqual(nginx_problems(NGINX.read_text(encoding="utf-8")), [])

    def test_caddy_example_keeps_its_method_rule(self):
        self.assertEqual(caddy_problems(CADDY.read_text(encoding="utf-8")), [])

    def test_the_checks_catch_a_missing_rule(self):
        broken = NGINX.read_text(encoding="utf-8").replace("return 405;", "return 404;")
        self.assertTrue(any("TRACE" in problem for problem in nginx_problems(broken)))
        broken = re.sub(r"limit_req zone=blog_heavy[^;]*;", "", NGINX.read_text(encoding="utf-8"))
        self.assertTrue(any("rate limited" in problem or "limit the rate" in problem for problem in nginx_problems(broken)))
        broken = NGINX.read_text(encoding="utf-8").replace("proxy_cache_valid 200 1h;", "proxy_cache_valid any 1h;")
        self.assertTrue(any("200" in problem for problem in nginx_problems(broken)))
        broken = NGINX.read_text(encoding="utf-8").replace("proxy_cache_key $scheme$host$uri;", "proxy_cache_key $scheme$host$request_uri;")
        self.assertTrue(any("the key" in problem for problem in nginx_problems(broken)))
        broken = NGINX.read_text(encoding="utf-8").replace("proxy_cache_valid 200 5m;", "proxy_cache_valid 200 1h;")
        self.assertTrue(any("/api/og/" in problem for problem in nginx_problems(broken)))
        broken = CADDY.read_text(encoding="utf-8").replace("respond 405", "respond 200")
        self.assertTrue(caddy_problems(broken))

    def test_a_rule_inside_a_comment_does_not_count(self):
        commented = "\n".join("# " + line for line in NGINX.read_text(encoding="utf-8").splitlines())
        self.assertGreater(len(nginx_problems(commented)), 5)


if __name__ == "__main__":
    unittest.main()
