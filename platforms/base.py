"""Plattform-Adapter. Neue Clipping-Plattform = Unterklasse in eigener Datei."""
from dataclasses import dataclass, field


@dataclass
class CampaignDraft:
    platform: str
    name: str
    external_url: str = ""
    rate_per_1k_usd: float | None = None
    raw_subject: str = ""


@dataclass
class CampaignRules:
    min_views: int = 0
    max_per_post_usd: float | None = None
    min_seconds: int = 0
    same_clip_multiple_accounts: bool = True   # Vyro: verboten nur auf demselben Account
    automation_sensitive: bool = True          # Plattform hat Anti-Automation-Klausel → Volumen niedrig halten


class Platform:
    key: str = "base"
    email_senders: list[str] = field(default_factory=list)

    def parse_email(self, subject: str, body: str, sender: str) -> CampaignDraft | None:
        """Erkennt neue Kampagne aus einer Benachrichtigungs-Mail. None wenn irrelevant."""
        raise NotImplementedError

    def parse_payout_email(self, subject: str, body: str) -> float | None:
        """Extrahiert Auszahlungsbetrag (USD) falls Mail eine Auszahlung/Freigabe ist."""
        return None

    def rules(self, campaign: dict) -> CampaignRules:
        return CampaignRules(min_views=campaign.get("min_views", 0),
                             max_per_post_usd=campaign.get("max_per_post_usd"),
                             min_seconds=campaign.get("min_seconds", 0))

    def caption(self, campaign: dict) -> str:
        req = campaign["required"]
        return req["caption"].rstrip() + "\n" + " ".join(req["hashtags"])

    def submission_hint(self, campaign: dict, urls: list[str]) -> str:
        """Text der Telegram-Nachricht zum manuellen Einreichen."""
        raise NotImplementedError
