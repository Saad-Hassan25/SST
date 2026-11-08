#!/usr/bin/env python3
"""Send a Prompter job-notification email via Gmail SMTP.

Everything comes from the environment; nothing sensitive is passed on argv (argv is
visible in process listings). Sending is best-effort: any failure is logged to stderr
and the script still exits 0, because a missed notification must never fail an
otherwise-successful job. The recipient address is never printed to the log.

Env:
  GMAIL_USERNAME       sending Gmail address (also the From)
  GMAIL_APP_PASSWORD   a Google app password (the account needs 2-Step Verification)
  EMAIL_TO             recipient
  EMAIL_SUBJECT        subject line
  EMAIL_TEXT           plain-text body
  EMAIL_HTML           optional HTML body
"""
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def send_notification(to, subject, text, html="", attachments=None):
    user = os.environ.get("GMAIL_USERNAME", "").strip()
    pw = os.environ.get("GMAIL_APP_PASSWORD", "")

    if not (user and pw and to):
        # No credentials configured, or no recipient: nothing to do, and not an error.
        log("notify: email not configured or no recipient; skipping.")
        return False

    msg = EmailMessage()
    msg["From"] = user
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    for name, content in (attachments or {}).items():
        msg.add_attachment(content, subtype="plain", charset="utf-8", filename=name)

    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ctx, timeout=30) as s:
            s.login(user, pw)
            s.send_message(msg)
        log("notify: email sent.")  # deliberately no recipient in the log
        return True
    except Exception as e:  # noqa: BLE001 - never fail the job over a notification
        log(f"notify: could not send email ({e.__class__.__name__}). Continuing.")
        return False


def main():
    return send_notification(
        os.environ.get("EMAIL_TO", "").strip(),
        os.environ.get("EMAIL_SUBJECT", "Your Prompter job"),
        os.environ.get("EMAIL_TEXT", "Your Prompter job has an update."),
        os.environ.get("EMAIL_HTML", ""),
    )


if __name__ == "__main__":
    main()
