"""Stub – Whop Content Rewards. Später ausfüllen; Scout kann Whop-Benachrichtigungsmails lesen."""
from .base import Platform


class Whop(Platform):
    key = "whop"
    email_senders = ["whop.com"]

    def parse_email(self, subject, body, sender):
        return None  # TODO

    def submission_hint(self, campaign, urls):
        return f"Whop – {campaign['name']}: Links in der Kampagne einreichen:\n" + "\n".join(urls)
