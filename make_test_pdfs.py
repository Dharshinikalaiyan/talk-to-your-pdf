"""
Creates 10 made-up PDFs in test_pdfs/ to try the app with a real library (upload them all at once).

Run me:  ../.venv/bin/python make_test_pdfs.py

Every company, person and number here is fictional. Each page holds different facts, so
you can check that an answer cites the right page. TEST_QUESTIONS.md lists what to ask.
"""

from pathlib import Path

from fpdf import FPDF

DOCS = {
    "Maple Court lease agreement": [
        ("Residential Lease Agreement - Maple Court, Flat 4B", [
            "This lease is between Maple Court Properties Ltd (the landlord) and the tenant named in the schedule. "
            "All names and details in this document are fictional.",
            "The lease runs for 12 months, starting on 1 March 2026 and ending on 28 February 2027.",
        ]),
        ("Rent and deposit", [
            "The monthly rent is 1,450 euros, due on the 1st day of each month by bank transfer.",
            "A late fee of 35 euros applies if rent is more than 5 days late.",
            "The security deposit is 2,900 euros (two months' rent) and is returned within 30 days after the tenant moves out.",
        ]),
        ("Rules and ending the lease", [
            "Pets are allowed with written permission from the landlord. Smoking is not allowed anywhere in the building.",
            "Either side may end the lease early with 60 days' written notice.",
            "The tenant is responsible for minor repairs under 100 euros; the landlord pays for larger repairs.",
        ]),
    ],
    "Brightwave employee handbook": [
        ("Brightwave Studio - Employee Handbook", [
            "Welcome to Brightwave Studio, a fictional design agency. This handbook explains how we work.",
            "Core hours are 10:00 to 16:00. Outside core hours, staff choose when to work.",
        ]),
        ("Time off", [
            "Full-time staff get 26 days of paid holiday a year, plus public holidays.",
            "Parental leave is 20 weeks at full pay for any new parent.",
            "Sick days do not need a doctor's note for the first 3 days in a row.",
        ]),
        ("Remote work and equipment", [
            "Staff may work remotely up to 3 days a week. Every new starter gets a laptop and a 500 euro home-office budget.",
            "Expenses must be submitted within 60 days through the expenses app.",
        ]),
    ],
    "Nimbus travel insurance policy": [
        ("Nimbus Travel Insurance - Policy Summary", [
            "Nimbus Insure is a fictional insurer. This summary covers the Silver single-trip policy.",
            "The policy covers trips of up to 45 days, for travellers aged up to 74.",
        ]),
        ("What is covered", [
            "Emergency medical costs are covered up to 5 million euros.",
            "Trip cancellation is covered up to 3,000 euros per person.",
            "Lost or stolen baggage is covered up to 1,500 euros, with a limit of 300 euros for any single item.",
        ]),
        ("Excess and claims", [
            "The excess (the amount you pay yourself) is 100 euros per claim.",
            "Claims must be made within 31 days of returning home. Winter sports and scuba diving are not covered.",
            "Call the 24-hour emergency line before going to hospital, unless it is a life-threatening emergency.",
        ]),
    ],
    "Aurora espresso machine manual": [
        ("Aurora Pro espresso machine - User Guide", [
            "The Aurora Pro is a fictional home espresso machine with a 1.8 litre water tank and a 15 bar pump.",
            "It heats up in about 40 seconds.",
        ]),
        ("Cleaning and descaling", [
            "Rinse the milk wand after every use. Clean the drip tray daily.",
            "Descale the machine every 2 months, or when the descale light turns orange. Descaling takes about 25 minutes.",
        ]),
        ("Lights and warranty", [
            "A blinking red light means the water tank is empty. A solid orange light means it is time to descale.",
            "The Aurora Pro has a 2-year warranty. Damage from not descaling is not covered.",
        ]),
    ],
    "Riverside Gym membership terms": [
        ("Riverside Gym - Membership Terms", [
            "Riverside Gym is a fictional gym. These terms apply to all memberships.",
            "The gym is open from 6:00 to 22:00 on weekdays and 8:00 to 20:00 at weekends.",
        ]),
        ("Prices", [
            "The Standard membership costs 39 euros a month. The Plus membership costs 59 euros a month and includes classes and the sauna.",
            "There is a one-time joining fee of 25 euros. Students get 20 percent off.",
        ]),
        ("Freezing and cancelling", [
            "You can freeze your membership for up to 3 months a year, for free.",
            "To cancel, give 1 month's notice in the app. There is no minimum contract.",
            "Guests may visit up to 4 times a year with a member.",
        ]),
    ],
    "Lumen city bus guide": [
        ("Lumen City Buses - Rider Guide", [
            "Lumen is a fictional city. Buses run from 5:30 to 00:30 every day.",
            "Night buses (lines N1 to N4) run every 30 minutes between 00:30 and 5:30 on Fridays and Saturdays.",
        ]),
        ("Tickets", [
            "A single ticket costs 2.20 euros and is valid for 90 minutes, including changes.",
            "A day pass costs 7 euros. A monthly pass costs 49 euros, or 25 euros for students and seniors.",
            "Children under 6 travel free.",
        ]),
        ("Lines and rules", [
            "Line 12 runs from the central station to the airport every 15 minutes and takes about 35 minutes.",
            "Bicycles are allowed on buses only outside rush hours (7:00 to 9:00 and 16:00 to 18:30).",
        ]),
    ],
    "Orbit Wi-Fi router quick start": [
        ("Orbit AX3000 Wi-Fi Router - Quick Start", [
            "The Orbit AX3000 is a fictional dual-band Wi-Fi 6 router.",
            "The default network name and password are printed on the sticker on the bottom of the router.",
        ]),
        ("Setting up", [
            "To open the settings, go to 192.168.50.1 in a browser. The default admin password is on the same sticker.",
            "Press the WPS button for 2 seconds to connect a device without a password.",
        ]),
        ("Lights and reset", [
            "A solid white light means you are online. A blinking amber light means there is no internet connection.",
            "To reset to factory settings, hold the reset button for 10 seconds until the light blinks white.",
        ]),
    ],
    "Greenleaf school prospectus": [
        ("Greenleaf Primary School - Prospectus", [
            "Greenleaf is a fictional primary school for children aged 4 to 11, with 320 pupils.",
            "The school day runs from 8:45 to 15:15. The gates open at 8:30.",
        ]),
        ("Admissions", [
            "Applications for September open on 1 October and close on 15 January.",
            "Average class size is 24 pupils.",
        ]),
        ("After school and uniform", [
            "The after-school club runs until 18:00 and costs 12 euros a day.",
            "Uniform is a green jumper with a white polo shirt. Trainers are allowed on sports days only.",
        ]),
    ],
    "Saffron Kitchen recipe booklet": [
        ("Saffron Kitchen - Weeknight Recipes", [
            "Three easy recipes from the fictional Saffron Kitchen cooking school. Each serves 4.",
        ]),
        ("Lemon chickpea curry", [
            "You need 2 tins of chickpeas, 1 tin of coconut milk, 1 onion, 2 garlic cloves, 1 lemon and 2 teaspoons of curry powder.",
            "Cook the onion for 5 minutes, add garlic and spices, then the chickpeas and coconut milk. Simmer for 20 minutes "
            "and finish with lemon juice. Total time: 30 minutes.",
        ]),
        ("Baked salmon and banana bread", [
            "Bake the salmon at 200 degrees Celsius for 12 to 15 minutes.",
            "For the banana bread, use 3 ripe bananas and bake at 175 degrees Celsius for 55 minutes. It keeps for 4 days in a tin.",
        ]),
    ],
    "Northwind solar panel warranty": [
        ("Northwind Solar - Panel Warranty", [
            "Northwind Solar is a fictional panel maker. This warranty covers the NW-420 panel.",
        ]),
        ("Product and performance warranty", [
            "The product warranty covers defects in materials and workmanship for 15 years.",
            "The performance warranty guarantees at least 87 percent of the original power output after 25 years.",
        ]),
        ("Making a claim", [
            "Claims must be made through the installer within 6 months of finding the problem, with photos and the serial number.",
            "The warranty does not cover damage from hail larger than 25 mm, lightning, or panels moved to a new address.",
        ]),
    ],
}


def build_all(folder: Path) -> list[Path]:
    folder.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, pages in DOCS.items():
        pdf = FPDF()
        pdf.set_auto_page_break(auto=True, margin=20)
        for title, paragraphs in pages:
            pdf.add_page()
            pdf.set_font("Helvetica", "B", 18)
            pdf.multi_cell(0, 10, title)
            pdf.ln(4)
            pdf.set_font("Helvetica", size=12)
            for p in paragraphs:
                pdf.multi_cell(0, 7, p)
                pdf.ln(3)
        path = folder / f"{name}.pdf"
        pdf.output(str(path))
        paths.append(path)
    return paths


if __name__ == "__main__":
    for p in build_all(Path(__file__).resolve().parent / "test_pdfs"):
        print(p.name)
