from .vyro import Vyro
from .whop import Whop

REGISTRY = {p.key: p for p in (Vyro(), Whop())}
