import importlib.util
import os
import unittest

spec = importlib.util.spec_from_file_location('docs_as_tests', os.path.join(os.path.dirname(__file__), 'docs-as-tests.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExtractTest(unittest.TestCase):
    def test_only_marked_blocks_are_returned_in_order(self):
        text = '\n'.join(['intro', '```bash', 'echo no', '```', '<!-- docs-test: run -->', '```bash', 'echo one', 'echo two', '```',
                          '<!-- docs-test: run -->', '````sh', 'echo three', '````'])
        self.assertEqual(module.extract(text), ['echo one\necho two', 'echo three'])

    def test_marker_not_followed_by_a_fence_is_ignored(self):
        self.assertEqual(module.extract('<!-- docs-test: run -->\nplain text\n```\nx\n```'), [])


class LoopbackTest(unittest.TestCase):
    """The recipes in the docs must not tell a reader to open a database, a backend or a dev server to the whole network."""

    def problems(self, block, lang='bash'):
        return module.loopback_problems('```' + lang + '\n' + block + '\n```')

    def test_docker_run_publishing_on_every_interface_is_found(self):
        self.assertEqual(len(self.problems('docker run -d --name pg -e POSTGRES_PASSWORD=x -p 15433:5432 postgres:18')), 1)
        self.assertEqual(len(self.problems('docker run -d --publish 5432:5432 postgres:18')), 1)
        self.assertEqual(len(self.problems('docker run -d -p 0.0.0.0:5432:5432 postgres:18')), 1)
        self.assertEqual(len(self.problems('docker run -d -p 8080 postgres:18')), 1)

    def test_docker_run_publishing_on_loopback_is_fine(self):
        self.assertEqual(self.problems('docker run -d -p 127.0.0.1:15433:5432 postgres:18'), [])
        self.assertEqual(self.problems('docker run -d --publish 127.0.0.1:7700:7700 -p [::1]:7701:7700 x'), [])
        self.assertEqual(self.problems('docker run --rm postgres:18 psql --version'), [])

    def test_a_command_continued_over_lines_is_read_as_one(self):
        block = 'docker run -d --name pg -e POSTGRES_USER=blog \\\n  -e POSTGRES_PASSWORD=blog -p 15433:5432 postgres:18'
        self.assertEqual(len(self.problems(block)), 1)
        fixed = block.replace('-p 15433', '-p 127.0.0.1:15433')
        self.assertEqual(self.problems(fixed), [])

    def test_a_dev_server_without_a_host_is_found(self):
        for command in ('npx next start -p 3100', 'npx next dev', 'npx next build && npx next start -p 3100', 'npm run dev'):
            self.assertEqual(len(self.problems(command)), 1, command)
        for command in ('npx next start -p 3100 -H localhost', 'npx next dev --hostname localhost', 'npm run dev -- -H localhost',
                        'npx next build'):
            self.assertEqual(self.problems(command), [], command)

    def test_a_literal_loopback_address_is_refused_because_the_locale_redirect_of_next_loops(self):
        for command in ('npx next start -p 3100 -H 127.0.0.1', 'npm run dev -- --hostname=127.0.0.1', 'npx next dev -H ::1'):
            found = self.problems(command)
            self.assertEqual(len(found), 1, command)
            self.assertIn('localhost', found[0])

    def test_a_backend_that_unlocks_the_dev_password_must_listen_on_loopback_only(self):
        unsafe = 'DB_PORT=15433 SETUP_LOCK_DEV_SEED=false APP_ALLOW_DEV_DEFAULTS=true java -jar target/app.jar'
        self.assertEqual(len(self.problems(unsafe)), 1)
        self.assertEqual(len(self.problems('SETUP_LOCK_DEV_SEED=false \\\n  mvn spring-boot:run')), 1)
        self.assertEqual(self.problems('SERVER_ADDRESS=127.0.0.1 ' + unsafe), [])
        self.assertEqual(self.problems(unsafe + ' --server.address=127.0.0.1'), [])
        self.assertEqual(self.problems('mvn spring-boot:run'), [])

    def test_prose_and_other_languages_are_not_scanned(self):
        self.assertEqual(module.loopback_problems('Run `docker run -p 5432:5432 postgres` yourself.'), [])
        self.assertEqual(self.problems('docker run -p 5432:5432 postgres', lang='text'), [])

    def test_a_line_can_say_why_it_is_exempt(self):
        self.assertEqual(self.problems('docker run -d -p 5432:5432 postgres:18  # loopback-ok: a throw-away VM'), [])

    def test_the_docs_of_the_repository_are_clean(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        files = ['README.md', 'README.vi.md', os.path.join('backend', 'README.md')]
        for folder in ('docs', os.path.join('docs', 'vi')):
            files += [os.path.join(folder, name) for name in sorted(os.listdir(os.path.join(root, folder))) if name.endswith('.md')]
        found = []
        for name in files:
            with open(os.path.join(root, name), encoding='utf-8') as handle:
                found += [f'{name}: {problem}' for problem in module.loopback_problems(handle.read())]
        self.assertEqual(found, [])

    def test_the_ci_workflow_follows_the_same_rules(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, '.github', 'workflows', 'ci.yml'), encoding='utf-8') as handle:
            text = handle.read()
        self.assertNotRegex(text, r'(?m)^\s+- \d+:\d+\s*$', 'a service port without a 127.0.0.1 prefix')
        self.assertNotRegex(text, r'(?m)^\s+services:', 'a service container publishes its ports on every interface')
        self.assertIn('-p 127.0.0.1:15433:5432', text)
        self.assertIn('next start -p 3100 -H localhost', text)
        self.assertIn('SERVER_ADDRESS=127.0.0.1', text)


if __name__ == '__main__':
    unittest.main()
