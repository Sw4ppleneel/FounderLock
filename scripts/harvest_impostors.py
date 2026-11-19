"""Non-founder faces for false-accept testing: generic searches for people who look like the
crowd at a Plaksha event. Any hit above threshold gets eyeballed (it might be a founder)."""
import sys, pathlib, concurrent.futures as cf
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from harvest_test_photos import bing, fetch_images, ROOT
QUERIES = [
 "Indian startup founder headshot", "Indian CEO portrait", "IIT professor portrait", "Indian venture capitalist headshot",
 "Indian CFO profile photo", "Indian woman entrepreneur portrait", "Indian tech executive keynote", "Bengaluru startup cofounder photo",
 "Indian university dean portrait", "Indian engineering student portrait", "Indian college students group", "NASSCOM leaders panel",
 "Indian business leader interview", "Indian investor angel headshot", "Indian professor IISc faculty", "Mumbai banker portrait",
 "Delhi entrepreneur headshot", "Indian product manager headshot", "Indian data scientist profile photo", "Indian MD managing director portrait",
 "Indian woman professor portrait", "Indian chairman group company portrait", "Indian software engineer headshot", "Indian scientist ISRO portrait",
 "IIM professor portrait", "Indian unicorn founder", "Indian fintech founder", "Indian edtech founder", "Indian pharma CEO", "Indian auto industry CEO",
]
def job(q):
    slug = q.lower().replace(" ", "-")
    try: return q, len(fetch_images(bing(q, 40), ROOT / "impostors_web" / slug, 25))
    except Exception as e: return q, str(e)
with cf.ThreadPoolExecutor(6) as ex:
    for q, n in ex.map(job, QUERIES): print(q, n, file=sys.stderr)
