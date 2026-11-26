"""Refresh data/tle.json. Run by .github/workflows/tle.yml, or by hand."""
import json
import os
import urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "tle.json")
CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle"
# IO-86 (LAPAN-A2) is not in Celestrak; SatNOGS publishes elements for it.
SATNOGS = "https://db.satnogs.org/api/tle/?norad_cat_id=40931&format=json"
WANTED = {7530, 25544, 27607, 43017, 43678, 43803, 44909}


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "tle-updater"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def from_celestrak():
    lines = [line.rstrip() for line in get(CELESTRAK).splitlines() if line.strip()]
    found = {}
    for first, second in zip(lines, lines[1:]):
        if first.startswith("1 ") and second.startswith("2 "):
            norad = int(first[2:7])
            if norad in WANTED:
                found[str(norad)] = [first, second]
    return found


def from_satnogs():
    item = json.loads(get(SATNOGS))[0]
    return {"40931": [item["tle1"], item["tle2"]]}


def main():
    data = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as handle:
            data = json.load(handle)
    failures = 0
    for source in (from_celestrak, from_satnogs):
        try:
            data.update(source())  # a failed source keeps the previous elements
        except Exception as error:
            failures += 1
            print(f"{source.__name__} failed: {error}")
    if failures == 2:
        raise SystemExit("no source reachable")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, indent=1, sort_keys=True)
    print(f"{len(data)} satellites written")


if __name__ == "__main__":
    main()
