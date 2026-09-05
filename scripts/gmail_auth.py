"""Einmalig lokal ausführen: erzeugt GMAIL_REFRESH_TOKEN (Scope gmail.readonly)."""
# pip install google-auth-oauthlib ; client_secret.json aus Google Cloud Console (OAuth-Client "Desktop")
from google_auth_oauthlib.flow import InstalledAppFlow
flow = InstalledAppFlow.from_client_secrets_file("client_secret.json", ["https://www.googleapis.com/auth/gmail.readonly"])
creds = flow.run_local_server(port=0)
print("GMAIL_REFRESH_TOKEN=", creds.refresh_token)
