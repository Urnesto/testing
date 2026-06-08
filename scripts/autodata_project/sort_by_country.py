import json
from collections import defaultdict

INPUT = "output/rrr_seller_data_deduped.json"
OUTPUT = "output/rrr_seller_data_by_country.json"

# Ordered longest-first so +370 matches before +37
PHONE_PREFIXES = {
    "+370": "Lithuania",
    "+371": "Latvia",
    "+372": "Estonia",
    "+373": "Moldova",
    "+374": "Armenia",
    "+375": "Belarus",
    "+376": "Andorra",
    "+377": "Monaco",
    "+378": "San Marino",
    "+380": "Ukraine",
    "+381": "Serbia",
    "+382": "Montenegro",
    "+385": "Croatia",
    "+386": "Slovenia",
    "+387": "Bosnia",
    "+389": "North Macedonia",
    "+420": "Czech Republic",
    "+421": "Slovakia",
    "+423": "Liechtenstein",
    "+352": "Luxembourg",
    "+353": "Ireland",
    "+354": "Iceland",
    "+355": "Albania",
    "+356": "Malta",
    "+357": "Cyprus",
    "+358": "Finland",
    "+359": "Bulgaria",
    "+351": "Portugal",
    "+350": "Gibraltar",
    "+315": "Netherlands",
    "+316": "Netherlands",
    "+317": "Netherlands",
    "+31":  "Netherlands",
    "+325": "Belgium",
    "+329": "Belgium",
    "+32":  "Belgium",
    "+346": "Spain",
    "+349": "Spain",
    "+34":  "Spain",
    "+393": "Italy",
    "+390": "Italy",
    "+39":  "Italy",
    "+407": "Romania",
    "+40":  "Romania",
    "+433": "Austria",
    "+43":  "Austria",
    "+452": "Denmark",
    "+456": "Denmark",
    "+457": "Denmark",
    "+458": "Denmark",
    "+45":  "Denmark",
    "+460": "Sweden",
    "+461": "Sweden",
    "+462": "Sweden",
    "+463": "Sweden",
    "+464": "Sweden",
    "+465": "Sweden",
    "+466": "Sweden",
    "+476": "Sweden",
    "+46":  "Sweden",
    "+482": "Poland",
    "+483": "Poland",
    "+485": "Poland",
    "+486": "Poland",
    "+487": "Poland",
    "+488": "Poland",
    "+48":  "Poland",
    "+492": "Germany",
    "+493": "Germany",
    "+494": "Germany",
    "+495": "Germany",
    "+49":  "Germany",
    "+44":  "United Kingdom",
    "+33":  "France",
    "+36":  "Hungary",
    "+37":  "Lithuania/Latvia/Estonia",
    "+41":  "Switzerland",
    "+47":  "Norway",
    "+7":   "Russia/Kazakhstan",
}

def get_country(phone: str) -> str:
    phone = phone.replace(" ", "").replace("-", "")
    # Try longest prefix first (4 chars, then 3, then 2)
    for length in (4, 3, 2):
        prefix = phone[:length]
        if prefix in PHONE_PREFIXES:
            return PHONE_PREFIXES[prefix]
    return "Unknown"

with open(INPUT, "r", encoding="utf-8") as f:
    data = json.load(f)

by_country = defaultdict(list)
for item in data:
    phone = item.get("seller_info", {}).get("Telefonas", "")
    country = get_country(phone) if phone else "Unknown"
    by_country[country].append(item)

# Sort countries alphabetically, Unknown last
sorted_countries = sorted(by_country.keys(), key=lambda c: ("z" if c == "Unknown" else c))
result = {c: by_country[c] for c in sorted_countries}

for country, items in result.items():
    print(f"{country:30s} {len(items):4d} sellers")

print(f"\nTotal: {sum(len(v) for v in result.values())} sellers across {len(result)} countries")

with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"Saved to {OUTPUT}")
