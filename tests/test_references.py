import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("checker", Path(__file__).resolve().parents[1] / "tools/check_references.py")
assert spec is not None and spec.loader is not None
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class ReferenceTests(unittest.TestCase):
    def test_missing_root(self):
        with tempfile.TemporaryDirectory() as temp:
            result = checker.inspect_reference(dict(id="missing", path=str(Path(temp) / "absent"), required_paths=["README.md"], observed_head=None))
            self.assertFalse(result["ok"])
            self.assertEqual(result["missing_paths"], ["README.md"])

    def test_real_repo_and_head_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            subprocess.run(["git", "init", "-q", temp], check=True)
            readme = Path(temp) / "README.md"
            readme.write_text("fixture\n")
            subprocess.run(["git", "-C", temp, "add", "README.md"], check=True)
            subprocess.run(["git", "-C", temp, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            entry = dict(id="fixture", path=temp, required_paths=["README.md"], observed_head="deliberately-different")
            result = checker.inspect_reference(entry)
            self.assertTrue(result["ok"])
            self.assertTrue(result["head_changed"])
            self.assertIsNotNone(result["current_head"])
            self.assertEqual(readme.read_text(), "fixture\n")

    def test_non_git_source_is_valid(self):
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / "runner.py").write_text("# fixture\n")
            result = checker.inspect_reference(dict(id="source", path=temp, required_paths=["runner.py"], observed_head=None))
            self.assertTrue(result["ok"])
            self.assertIsNone(result["current_head"])
            self.assertFalse(result["head_changed"])


if __name__ == "__main__":
    unittest.main()
