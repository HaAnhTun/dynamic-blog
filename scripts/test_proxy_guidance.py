"""Guard for the guidance on Cloudflare in front of the reverse proxy (offline, standard library only).

`TRUSTED_PROXY_HOPS=2` makes Next read the second entry from the right of `X-Forwarded-For`. That entry is the visitor only
when the request really came through Cloudflare: nginx appends to whatever the caller sent, so a caller who reaches the origin
directly (its address leaked, or never hidden) chooses the key of every per-address limit in Next and in the backend (issue 116).

So every place that recommends two hops must say, in the same paragraph, that the origin has to accept Cloudflare alone, and the
nginx example must show the safe form: restore the visitor address with `set_real_ip_from` for Cloudflare's ranges only and keep
one hop, which holds even when the origin is reachable.

run: python scripts/test_proxy_guidance.py
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Files that tell an operator what to set. The Vietnamese install guide is checked separately (its prose is not English).
GUIDANCE = [
    "docs/INSTALL.md",
    "docs/SECURITY.md",
    "docs/CONFIGURATION.md",
    "docs/TROUBLESHOOTING.md",
    ".env.example",
    "docker-compose.yml",
    "deploy/nginx.conf.example",
    "deploy/Caddyfile.example",
]

# A recommendation of two hops: the variable set to 2, or "2 for/with Cloudflare" in prose.
TWO_HOPS = re.compile(r"TRUSTED_PROXY_HOPS[=:]\s*2\b|`?\b2\b`?\s+(?:for|with)\s+Cloudflare", re.IGNORECASE)


def paragraphs(text):
    """Blocks separated by a blank line or by the start of a list item; comment markers do not end a block."""
    return [block for block in re.split(r"\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)", text) if block.strip()]


def unrestricted_two_hops(text):
    """The paragraphs that recommend two hops without naming the origin restriction."""
    found = []
    for block in paragraphs(text):
        if not TWO_HOPS.search(block):
            continue
        says_origin = "origin" in block.lower()
        says_only = re.search(r"\b(alone|only)\b", block, re.IGNORECASE) is not None
        if not (says_origin and says_only and "Cloudflare" in block):
            found.append(" ".join(block.split())[:160])
    return found


class ProxyGuidance(unittest.TestCase):
    def read(self, relative):
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_every_recommendation_of_two_hops_names_the_origin_restriction(self):
        for relative in GUIDANCE:
            with self.subTest(file=relative):
                self.assertEqual([], unrestricted_two_hops(self.read(relative)))

    def test_the_check_notices_a_missing_restriction(self):
        bad = "Behind Cloudflare set `TRUSTED_PROXY_HOPS=2` and you are done."
        good = "Behind Cloudflare set `TRUSTED_PROXY_HOPS=2` only if the origin accepts Cloudflare alone."
        self.assertEqual(1, len(unrestricted_two_hops(bad)))
        self.assertEqual([], unrestricted_two_hops(good))
        self.assertEqual(1, len(unrestricted_two_hops("Use 2 with Cloudflare.")))

    def test_the_nginx_example_restores_the_visitor_address_for_cloudflare_peers_only(self):
        nginx = self.read("deploy/nginx.conf.example")
        self.assertIn("set_real_ip_from", nginx)
        self.assertIn("real_ip_header CF-Connecting-IP", nginx)
        self.assertIn("include /etc/nginx/cloudflare-realip.conf;", nginx)
        # The include is shipped commented out: an operator without Cloudflare must not trust a header by accident.
        active = [line for line in nginx.splitlines() if line.strip() and not line.strip().startswith("#")]
        self.assertFalse([line for line in active if "real_ip" in line or "cloudflare-realip" in line])

    def test_the_install_guide_says_how_to_build_the_range_file_and_lock_the_origin(self):
        install = self.read("docs/INSTALL.md")
        self.assertIn("cloudflare-realip.conf", install)
        self.assertIn("https://www.cloudflare.com/ips-v4", install)
        self.assertIn("https://www.cloudflare.com/ips-v6", install)
        self.assertIn("Authenticated Origin Pulls", install)

    def test_the_vietnamese_install_guide_carries_the_same_instructions(self):
        install = self.read("docs/vi/INSTALL.md")
        self.assertIn("cloudflare-realip.conf", install)
        self.assertIn("set_real_ip_from", install)
        self.assertIn("Authenticated Origin Pulls", install)
        self.assertIn("origin", install)

    def test_security_notes_explain_why_a_direct_caller_cannot_choose_the_key(self):
        security = self.read("docs/SECURITY.md")
        self.assertIn("cloudflare-realip.conf", security)
        self.assertIn("CF-Connecting-IP", security)


if __name__ == "__main__":
    unittest.main()
