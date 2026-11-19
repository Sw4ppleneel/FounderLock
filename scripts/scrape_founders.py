"""Scrape Plaksha's public Founding Members directory into founders.json + photos."""
import urllib.error, html, json, re, sys, time, urllib.request, pathlib, concurrent.futures as cf

OUT = pathlib.Path(sys.argv[1])
UA = {"User-Agent": "Mozilla/5.0"}
BASE = "https://plaksha.edu.in/founding-members"

def get(url, binary=False):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                d = r.read()
                return d if binary else d.decode("utf-8", "replace")
        except Exception as e:
            err = e; time.sleep(1 + i)
    raise err

def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()

people = []
for p in range(1, 20):
    try:
        page = get(BASE if p == 1 else f"{BASE}/page/{p}")
    except urllib.error.HTTPError:
        break
    cards = re.findall(r'<li\s+class=" pb-4.*?</li>', page, flags=re.S)
    if not cards: break
    for c in cards:
        a = re.search(r'<h3[^>]*>\s*<a\s+href="([^"]+)"[^>]*>(.*?)</a>', c, re.S)
        if not a: continue
        url, name = a.group(1), clean(a.group(2))
        img = re.search(r'srcset="[^"]*?(https://\S+?)\s+500w', c) or re.search(r'<img[^>]+src="([^"]+)"', c)
        role = re.search(r'<div\s+class="font-semibold">(.*?)</div>', c, re.S)
        edu = re.search(r'<div\s+class="font-regular text-grey">(.*?)</div>', c, re.S)
        people.append({
            "id": url.rstrip("/").split("/")[-1],
            "name": name,
            "category": url.rstrip("/").split("/")[-2],
            "role": clean(role.group(1)) if role else "",
            "education": clean(edu.group(1)) if edu else "",
            "profileUrl": url,
            "imageUrl": img.group(1) if img else None,
        })
    print(f"page {p}: {len(cards)} cards", file=sys.stderr)

def enrich(person):
    try:
        pg = get(person["profileUrl"])
        main = re.search(r"<main.*?</main>", pg, re.S).group(0)
        paras = [clean(x) for x in re.findall(r"<p[^>]*>(.*?)</p>", main, re.S)]
        person["bio"] = [x for x in paras if len(x) > 60][:6]
        links = re.findall(r'href="(https?://(?:www\.)?(?:linkedin\.com|twitter\.com|x\.com)/[^"]+)"', main)
        person["links"] = sorted(set(links))
    except Exception as e:
        person["bio"], person["links"] = [], []
        print("bio fail", person["id"], e, file=sys.stderr)
    if person["imageUrl"]:
        ext = person["imageUrl"].rsplit(".", 1)[-1].split("?")[0]
        f = OUT / "photos" / f"{person['id']}.{ext}"
        try:
            if not f.exists(): f.write_bytes(get(person["imageUrl"], binary=True))
            person["photo"] = f"photos/{f.name}"
        except Exception as e:
            print("photo fail", person["id"], e, file=sys.stderr)
    return person

# Two different people can share a URL slug (e.g. two "Ashish Gupta"s): make ids unique.
seen = {}
for person in people:
    n = seen.get(person["id"], 0) + 1
    seen[person["id"]] = n
    if n > 1:
        person["id"] = f"{person['id']}-{n}"

(OUT / "photos").mkdir(parents=True, exist_ok=True)
with cf.ThreadPoolExecutor(8) as ex:
    people = list(ex.map(enrich, people))
(OUT / "founders.json").write_text(json.dumps(people, indent=2, ensure_ascii=False))
print(len(people), "people", file=sys.stderr)
