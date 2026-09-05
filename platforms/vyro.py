import re
from .base import Platform, CampaignDraft


class Vyro(Platform):
    key = "vyro"
    # Absender/Betreff sind nicht dokumentiert → nach erster echter Mail hier kalibrieren.
    email_senders = ["vyro.com"]
    new_campaign_patterns = [r"new campaign", r"campaign.*(live|dropped|now open)"]
    payout_patterns = [r"approved", r"earnings", r"payout", r"available"]

    def parse_email(self, subject, body, sender):
        if not any(s in sender.lower() for s in self.email_senders):
            return None
        text = f"{subject}\n{body}".lower()
        if not any(re.search(p, text) for p in self.new_campaign_patterns):
            return None
        url = next(iter(re.findall(r"https?://(?:app\.)?vyro\.com/campaigns/[\w\-]+", body)), "")
        rate = re.search(r"\$([\d,]+)\s*per\s*1m", text)
        rate_1k = float(rate.group(1).replace(",", "")) / 1000 if rate else None
        return CampaignDraft(platform=self.key, name=subject.strip(), external_url=url,
                             rate_per_1k_usd=rate_1k, raw_subject=subject)

    def parse_payout_email(self, subject, body):
        text = f"{subject}\n{body}".lower()
        if not any(re.search(p, text) for p in self.payout_patterns):
            return None
        m = re.search(r"\$\s?([\d,]+\.?\d*)", body)
        return float(m.group(1).replace(",", "")) if m else None

    def submission_hint(self, campaign, urls):
        lines = [f"📎 Vyro – {campaign['name']}: {len(urls)} Posts einreichen",
                 campaign.get("external_url", ""), ""]
        lines += urls
        lines += ["", "App öffnen → Kampagne → Add post → URLs einfügen. Danach 'ok' antworten."]
        return "\n".join(lines)
