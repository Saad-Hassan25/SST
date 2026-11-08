import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('studio', Path(__file__).parents[1] / 'scripts/studio.py')
studio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(studio)


class LocalBackendTests(unittest.TestCase):
    def test_media_ids_cannot_escape_the_work_folder(self):
        for value in ('../secrets', 'a' * 31, None, 'A' * 32):
            with self.assertRaises(ValueError):
                studio.media_path(value)

    def test_upload_requires_same_origin_and_downloads_cannot_escape_data(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(studio, 'DATA', Path(directory)):
            server = studio.ThreadingHTTPServer(('127.0.0.1', 0), studio.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                request = urllib.request.Request(base + '/api/uploads', data=b'media', headers={'Origin': 'https://foreign.test', 'X-Filename': 'video.mp4'})
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(request)
                self.assertEqual(caught.exception.code, 403)
                request = urllib.request.Request(base + '/api/uploads', data=b'media', headers={'Origin': base, 'X-Filename': 'video.mp4'})
                with urllib.request.urlopen(request) as response:
                    value = json.load(response)
                self.assertEqual(studio.media_path(value['media_id']).read_bytes(), b'media')
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(base + '/api/files/%2e%2e/.gitignore')
                self.assertEqual(caught.exception.code, 404)
            finally:
                server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
