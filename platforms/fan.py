"""Fan-Content (eigene YouTube-Quellen, keine Clipping-Plattform): Caption „<Hook> · Credit @mrbeast #mrbeast“,
kein Branded Content, keine Einreichung, keine Kampagnen-Hashtags."""
from .base import Platform, CampaignRules


class Fan(Platform):
    key = "fan"
    email_senders: list[str] = []

    def parse_email(self, subject, body, sender):
        return None

    def rules(self, campaign):
        return CampaignRules(min_views=0, max_per_post_usd=None, min_seconds=int(campaign.get("min_seconds") or 15),
                             same_clip_multiple_accounts=False, automation_sensitive=False)

    def caption(self, campaign, hook=""):
        req = campaign.get("required") or {}
        credit = (req.get("caption") or "Credit @mrbeast").strip()
        tags = " ".join(req.get("hashtags") or ["#mrbeast"])
        return f"{hook.strip()} · {credit} {tags}".strip(" ·") if hook and hook.strip() else f"{credit} {tags}"

    def submission_hint(self, campaign, urls):
        return ""
