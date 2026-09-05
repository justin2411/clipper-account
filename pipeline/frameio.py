"""Frame.io-Share-Download ohne Login (next.frame.io/share/<id>). Nutzt die öffentliche GraphQL-API der Web-App:
der Share-Auth-Header ist die Base64-kodierte Share-ID. Listet alle Dateien (rekursiv über Ordner) und lädt die
Originale. Vyro liefert Footage genau so aus."""
import base64, re, requests
from pathlib import Path

GQL = "https://api.frame.io/graphql"
Q_LIST = """query L($shareId: ID!, $folderId: ID, $assetType: ChildAssetTypeInput, $page: PageInput!) {
  share(shareId: $shareId) { id ... on Share {
    collectionAssets(page: $page, assetType: $assetType, folderId: $folderId) {
      pageInfo { endCursor hasNextPage } nodes { id } } } } }"""
Q_HYDRATE = """query H($ids: [ID!]!) { assets(assetIds: $ids) { id name assetType
  ... on VideoAsset { media { original { downloadUrl filesizeInBytes } } }
  ... on FolderAsset { itemCount } } }"""


def share_id(url: str) -> str:
    m = re.search(r"/share/([0-9a-f-]{36})", url) or re.search(r"/reviews?/([0-9a-f-]{36})", url)
    if not m:
        raise ValueError(f"keine Frame.io-Share-ID in {url}")
    return m.group(1)


class FrameioShare:
    def __init__(self, url: str):
        self.id = share_id(url)
        self.h = {"Content-Type": "application/json", "apollographql-client-name": "web-app",
                  "x-frameio-share-authentication": base64.b64encode(self.id.encode()).decode().rstrip("="),
                  "Origin": "https://next.frame.io", "Referer": f"https://next.frame.io/share/{self.id}/"}

    def _gql(self, query: str, variables: dict) -> dict:
        r = requests.post(GQL, headers=self.h, json={"query": query, "variables": variables}, timeout=60)
        r.raise_for_status()
        d = r.json()
        if d.get("errors"):
            raise RuntimeError(f"frame.io: {d['errors'][0].get('message')}")
        return d["data"]

    def _ids(self, asset_type: str, folder_id=None) -> list[str]:
        ids, cursor = [], None
        while True:
            page = {"first": 200, **({"after": cursor} if cursor else {})}
            d = self._gql(Q_LIST, {"shareId": self.id, "folderId": folder_id, "assetType": asset_type, "page": page})
            ca = d["share"]["collectionAssets"]
            ids += [n["id"] for n in ca["nodes"]]
            if not ca["pageInfo"]["hasNextPage"]:
                return ids
            cursor = ca["pageInfo"]["endCursor"]

    def files(self, folder_id=None) -> list[dict]:
        """Alle Video-Dateien im Share (rekursiv): [{id, name, url, size}]"""
        out = []
        ids = self._ids("FILE", folder_id)
        for i in range(0, len(ids), 50):
            for a in self._gql(Q_HYDRATE, {"ids": ids[i:i + 50]})["assets"]:
                o = ((a.get("media") or {}).get("original") or {})
                if o.get("downloadUrl"):
                    out.append({"id": a["id"], "name": a["name"], "url": o["downloadUrl"], "size": o.get("filesizeInBytes") or 0})
        for fid in self._ids("FOLDER", folder_id):
            out += self.files(fid)
        return out

    def download_all(self, dest: Path) -> list[Path]:
        dest.mkdir(parents=True, exist_ok=True)
        paths = []
        for f in self.files():
            p = dest / re.sub(r"[^\w.\- ]+", "_", f["name"])
            if p.exists() and f["size"] and p.stat().st_size == f["size"]:
                paths.append(p); continue
            with requests.get(f["url"], stream=True, timeout=600) as r:
                r.raise_for_status()
                with open(p, "wb") as fh:
                    for chunk in r.iter_content(1 << 20):
                        fh.write(chunk)
            print(f"[frameio] {p.name} {p.stat().st_size} bytes")
            paths.append(p)
        return paths
