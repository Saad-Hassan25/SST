import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("caption", Path(__file__).parents[1] / "scripts/caption.py")
caption = importlib.util.module_from_spec(spec)
spec.loader.exec_module(caption)


class CaptionTests(unittest.TestCase):
    def test_unicode_and_style_commands(self):
        result = caption.validate_srt("1\n00:00:01,000 --> 00:00:04,000\n{\\pos(0,0)}<b>Speaker 1: مرحبا</b>\n")
        self.assertIn("Speaker 1: مرحبا", result)
        self.assertNotIn("pos(", result)
        self.assertNotIn("<b>", result)

    def test_bad_subtitles(self):
        for text in ["", "hello", "1\n00:00:99,000 --> 00:00:01,000\nhello", "1\n00:00:04,000 --> 00:00:01,000\nhello", "x" * 40001]:
            with self.assertRaises(ValueError):
                caption.validate_srt(text)

    def test_fixed_filter_and_argument_array(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input"
            source.mkdir()
            (source / "video's name.mp4").touch()
            output = Path(directory) / "output"
            with patch("sys.argv", ["caption.py", "--input-dir", str(source), "--out-dir", str(output)]), \
                    patch.dict("os.environ", {"SUBTITLES": "1\n00:00:00,000 --> 00:00:01,000\nHello", "CAPTION_STYLE": "bold"}), \
                    patch.object(caption.subprocess, "run") as run:
                caption.main()
                args, kwargs = run.call_args
                self.assertIsInstance(args[0], list)
                self.assertIn("subtitles=captions.srt:", args[0][args[0].index("-vf") + 1])
                self.assertNotIn("shell", kwargs)
                self.assertEqual(kwargs["timeout"], 18000)
                self.assertTrue((output / "captions.srt").exists())


if __name__ == "__main__":
    unittest.main()
