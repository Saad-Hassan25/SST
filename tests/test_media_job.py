import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

scripts=Path(__file__).parents[1]/'scripts'
sys.path.insert(0,str(scripts))
import media_job
import send_email


class BackgroundMediaTests(unittest.TestCase):
    def test_translated_subtitles_keep_boundaries_and_export_unicode(self):
        cues=[{'start':.16,'end':.96,'text':'Hello.'},{'start':2,'end':3,'text':'Welcome.'}]
        calls=[]
        def chat(model,messages):
            calls.append(model)
            return '[0] مرحباً. [1] أهلاً.'
        result=media_job.translate_cues(cues,'en','ar',chat)
        self.assertEqual([(c['start'],c['end']) for c in result],[(.16,.96),(2,3)])
        files=media_job.exports(cues,result)
        self.assertIn('00:00:00,160 --> 00:00:00,960',files['translated.srt'])
        self.assertIn('مرحباً',files['translation.txt'])
        self.assertEqual(calls,['nvidia/riva-translate-4b-instruct-v2'])
        with self.assertRaises(ValueError):
            media_job.translate_cues(cues,'en','ar',lambda *_:'[0] One missing cue')

    def test_email_attachments_and_explicit_sending_status(self):
        with patch.dict(os.environ,{'GMAIL_USERNAME':'sender@example.com','GMAIL_APP_PASSWORD':'test-only'}),patch.object(send_email.smtplib,'SMTP_SSL') as smtp:
            sent=send_email.send_notification('recipient@example.com','Your recording is ready','Ready.',attachments={'transcript.txt':'Hello','translated.srt':'مرحبا'})
            self.assertTrue(sent)
            message=smtp.return_value.__enter__.return_value.send_message.call_args.args[0]
            self.assertEqual(message['To'],'recipient@example.com')
            self.assertEqual([p.get_filename() for p in message.iter_attachments()],['transcript.txt','translated.srt'])
        with patch.dict(os.environ,{'GMAIL_USERNAME':'sender@example.com','GMAIL_APP_PASSWORD':'test-only'}),patch.object(send_email.smtplib,'SMTP_SSL',side_effect=OSError('test failure')):
            self.assertFalse(send_email.send_notification('recipient@example.com','Ready','Ready.'))

    def test_word_timing_does_not_use_estimated_timings_for_parakeet(self):
        result=media_job.words_to_cues([{'text':'Hello','start':.16,'end':.48},{'text':'everyone.','start':.64,'end':.96}])
        self.assertEqual(result,[{'start':.16,'end':.96,'text':'Hello everyone.'}])


if __name__=='__main__':
    unittest.main()
