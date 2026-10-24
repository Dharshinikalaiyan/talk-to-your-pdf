"""
Creates data/sample_manual.pdf: a made-up 5-page product manual to try the assistant with.

Run me:  ../.venv/bin/python make_sample_pdf.py

Each page holds different facts, so you can check that answers cite the right page.
"""

from pathlib import Path

from fpdf import FPDF

PAGES = [
    ("Helios H2 Home Battery - Owner's Manual", [
        "This manual covers the Helios H2, a fictional home battery made by the fictional company Helios Energy.",
        "The Helios H2 stores 13.5 kWh of energy and delivers up to 5 kW of continuous power. It weighs 114 kg "
        "and is designed for wall or floor mounting, indoors or outdoors.",
        "Read the safety section on page 2 before installing or servicing the battery.",
    ]),
    ("Safety", [
        "Only a certified electrician may install the Helios H2. Never open the battery enclosure; there are no "
        "user-serviceable parts inside.",
        "Keep the battery at least 1 metre away from heat sources and do not install it in a bathroom or a room "
        "that floods. The operating temperature range is -20 to 50 degrees Celsius.",
        "If the battery smells of burning or makes a hissing sound, leave the building and call the fire service.",
    ]),
    ("Installation", [
        "Mount the battery on a wall that can hold at least 150 kg. Leave 30 cm of clear space on each side for "
        "airflow.",
        "Connect the battery to the inverter with the supplied DC cable, then switch the isolator to ON. The "
        "status light blinks blue during the first start-up, which takes about 10 minutes.",
        "Register the battery in the Helios app within 30 days to activate the warranty.",
    ]),
    ("Status lights and troubleshooting", [
        "Solid green: normal operation. Blinking blue: starting up. Solid amber: battery is too hot or too cold "
        "and has paused charging. Blinking red: fault; note the error code shown in the app.",
        "Error E07 means the inverter connection was lost. Check the DC cable and restart the inverter.",
        "Error E12 means the internal temperature is outside the safe range. The battery resumes automatically "
        "when the temperature returns to normal.",
    ]),
    ("Warranty and support", [
        "The Helios H2 has a 10-year warranty or 37.8 MWh of total energy throughput, whichever comes first. "
        "The battery is guaranteed to keep at least 70 percent of its original capacity during the warranty.",
        "The warranty does not cover damage from floods, fire, or installation by an uncertified person.",
        "Contact support through the Helios app. Support is available Monday to Friday, 8:00 to 18:00.",
    ]),
]


def build(path: Path) -> Path:
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=20)
    for title, paragraphs in PAGES:
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 18)
        pdf.multi_cell(0, 10, title)
        pdf.ln(4)
        pdf.set_font("Helvetica", size=12)
        for p in paragraphs:
            pdf.multi_cell(0, 7, p)
            pdf.ln(3)
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf.output(str(path))
    return path


if __name__ == "__main__":
    print(build(Path(__file__).resolve().parent / "data" / "sample_manual.pdf"))
