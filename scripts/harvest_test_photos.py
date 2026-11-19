"""Collect TEST photos (never used for the reference gallery unless verified):
  data/web/<founder-id>/NN.img   public web photos of each founder (Bing Images)
  data/impostors/<slug>.img      Plaksha faculty headshots = people who must NOT match
"""
import html, json, re, sys, time, pathlib, urllib.parse, urllib.request, urllib.error, concurrent.futures as cf

ROOT = pathlib.Path(__file__).resolve().parent.parent / "data"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"}
PER_FOUNDER = int(sys.argv[1]) if len(sys.argv) > 1 else 8

def get(url, timeout=15):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")

def bing(query, n=30):
    q = urllib.parse.quote_plus(query)
    page, _ = get(f"https://www.bing.com/images/search?q={q}&form=HDRSC2&first=1")
    page = page.decode("utf-8", "replace")
    out = []
    for m in re.finditer(r'm="(\{[^"]+\})"', page):
        try:
            d = json.loads(html.unescape(m.group(1)))
        except Exception:
            continue
        if d.get("murl"):
            out.append({"url": d["murl"], "page": d.get("purl", ""), "title": d.get("t", "")})
    return out[:n]

def fetch_images(cands, dest, limit):
    dest.mkdir(parents=True, exist_ok=True)
    kept = []
    for c in cands:
        if len(kept) >= limit: break
        host = urllib.parse.urlparse(c["url"]).netloc
        if "plaksha.edu.in" in host or "linkedin" in host or "lookaside" in host:
            continue  # plaksha = reference photo itself; skip login-walled platforms
        try:
            data, ctype = get(c["url"], timeout=12)
        except Exception:
            continue
        if not (4_000 < len(data) < 10_000_000): continue
        if not (data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[8:12] == b"WEBP"): continue
        f = dest / f"{len(kept):02d}.img"
        f.write_bytes(data)
        kept.append({**c, "file": f.name})
    (dest / "sources.json").write_text(json.dumps(kept, indent=1))
    return kept

def company(role):
    return role.split(",")[-1].strip() if "," in role else role

def founder_job(p):
    dest = ROOT / "web" / p["id"]
    if (dest / "sources.json").exists():
        return p["id"], len(json.loads((dest / "sources.json").read_text()))
    name = re.sub(r"^Dr\.?\s+", "", p["name"])
    try:
        cands = bing(f'"{name}" {company(p["role"])}')
        if len(cands) < 10:
            cands += bing(f'"{name}"')
    except Exception as e:
        return p["id"], f"search failed: {e}"
    return p["id"], len(fetch_images(cands, dest, PER_FOUNDER))

def faculty():
    dest = ROOT / "impostors"; dest.mkdir(parents=True, exist_ok=True)
    n = 0
    for section in ["full-time", "visiting", "adjunct", "guest"]:
        for pg in range(1, 30):
            url = f"https://plaksha.edu.in/faculty/{section}" + ("" if pg == 1 else f"/page/{pg}")
            try:
                page = get(url)[0].decode("utf-8", "replace")
            except urllib.error.HTTPError:
                break
            imgs = re.findall(r'srcset="[^"]*?(https://resources\.plaksha\.edu\.in/\S+?)\s+500w"[^>]*alt="([^"]+)"', page)
            if not imgs: break
            for src, alt in imgs:
                slug = re.sub(r"[^a-z0-9]+", "-", html.unescape(alt).lower()).strip("-")
                f = dest / f"{slug}.img"
                if f.exists(): continue
                try:
                    f.write_bytes(get(src)[0]); n += 1
                except Exception:
                    pass
    return n

if __name__ == "__main__":
    founders = json.loads((ROOT / "founders.json").read_text())
    print("faculty photos:", faculty(), file=sys.stderr)
    with cf.ThreadPoolExecutor(6) as ex:
        for fid, res in ex.map(founder_job, founders):
            print(f"{fid}: {res}", file=sys.stderr)
