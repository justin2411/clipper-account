from .vyro import Vyro
from .whop import Whop
from .fan import Fan

REGISTRY = {p.key: p for p in (Vyro(), Whop(), Fan())}
