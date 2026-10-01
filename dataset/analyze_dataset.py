import csv
from pathlib import Path
from collections import Counter


# ============================================================
# FILE LOCATION
# ============================================================

BASE_DIR = Path(__file__).parent
CSV_PATH = BASE_DIR / "sensor_data.csv"


# ============================================================
# LOAD DATASET
# ============================================================

def load_dataset():

    if not CSV_PATH.exists():
        print("ERROR: sensor_data.csv was not found.")
        return []

    with open(
        CSV_PATH,
        "r",
        encoding="utf-8"
    ) as file:

        reader = csv.DictReader(file)

        return list(reader)


# ============================================================
# SAFE FLOAT CONVERSION
# ============================================================

def to_float(value):

    if value == "" or value is None:
        return None

    try:
        return float(value)

    except ValueError:
        return None


# ============================================================
# CALCULATE AVERAGE
# ============================================================

def calculate_average(values):

    valid_values = [
        value
        for value in values
        if value is not None
    ]

    if not valid_values:
        return 0

    return sum(valid_values) / len(valid_values)


# ============================================================
# ANALYZE DATASET
# ============================================================

def analyze_dataset(data):

    if not data:
        print("No data available.")
        return

    total_records = len(data)

    # ========================================================
    # FAULT ANALYSIS
    # ========================================================

    fault_counts = Counter(
        row["fault_type"]
        for row in data
    )

    normal_records = fault_counts.get(
        "normal",
        0
    )

    faulty_records = (
        total_records
        - normal_records
    )

    # ========================================================
    # SENSOR DATA
    # ========================================================

    irradiance = [
        to_float(row["irradiance"])
        for row in data
    ]

    ambient_temperature = [
        to_float(row["ambient_temperature"])
        for row in data
    ]

    panel_temperature = [
        to_float(row["panel_temperature"])
        for row in data
    ]

    humidity = [
        to_float(row["humidity"])
        for row in data
    ]

    wind_speed = [
        to_float(row["wind_speed"])
        for row in data
    ]

    normal_voltage = [
        to_float(row["normal_voltage"])
        for row in data
    ]

    faulty_voltage = [
        to_float(row["faulty_voltage"])
        for row in data
    ]

    current = [
        to_float(row["current"])
        for row in data
    ]

    normal_power = [
        to_float(row["normal_power"])
        for row in data
    ]

    measured_power = [
        to_float(row["measured_power"])
        for row in data
    ]

    energy = [
        to_float(row["energy_kwh"])
        for row in data
    ]

    grid_voltage = [
        to_float(row["grid_voltage"])
        for row in data
    ]

    grid_frequency = [
        to_float(row["grid_frequency"])
        for row in data
    ]

    power_factor = [
        to_float(row["power_factor"])
        for row in data
    ]

    inverter_temperature = [
        to_float(row["inverter_temperature"])
        for row in data
    ]

    # ========================================================
    # MISSING DATA
    # ========================================================

    missing_voltage = sum(
        1
        for value in faulty_voltage
        if value is None
    )

    # ========================================================
    # FAULT SEVERITY
    # ========================================================

    severity_counts = Counter(
        int(row["fault_severity"])
        for row in data
    )

    # ========================================================
    # DISPLAY REPORT
    # ========================================================

    print()
    print("========================================")
    print("SOLAR ENERGY DATA ANALYSIS")
    print("========================================")

    # ========================================================
    # GENERAL
    # ========================================================

    print("\nGENERAL")
    print("----------------------------------------")

    print(
        f"Total records          : "
        f"{total_records}"
    )

    print(
        f"Normal records         : "
        f"{normal_records}"
    )

    print(
        f"Faulty records         : "
        f"{faulty_records}"
    )

    if total_records > 0:

        fault_percentage = (
            faulty_records
            / total_records
        ) * 100

        print(
            f"Fault percentage       : "
            f"{fault_percentage:.2f}%"
        )

    # ========================================================
    # ENVIRONMENT
    # ========================================================

    print("\nENVIRONMENT")
    print("----------------------------------------")

    print(
        f"Average irradiance     : "
        f"{calculate_average(irradiance):.2f} W/m²"
    )

    print(
        f"Average ambient temp   : "
        f"{calculate_average(ambient_temperature):.2f} °C"
    )

    print(
        f"Average panel temp     : "
        f"{calculate_average(panel_temperature):.2f} °C"
    )

    print(
        f"Average humidity       : "
        f"{calculate_average(humidity):.2f}%"
    )

    print(
        f"Average wind speed     : "
        f"{calculate_average(wind_speed):.2f} m/s"
    )

    # ========================================================
    # ELECTRICAL
    # ========================================================

    print("\nELECTRICAL")
    print("----------------------------------------")

    print(
        f"Average voltage        : "
        f"{calculate_average(normal_voltage):.2f} V"
    )

    print(
        f"Average current        : "
        f"{calculate_average(current):.2f} A"
    )

    print(
        f"Average normal power   : "
        f"{calculate_average(normal_power):.2f} W"
    )

    print(
        f"Average measured power : "
        f"{calculate_average(measured_power):.2f} W"
    )

    if energy and energy[-1] is not None:

        print(
            f"Final energy           : "
            f"{energy[-1]:.6f} kWh"
        )

    print(
        f"Average grid voltage   : "
        f"{calculate_average(grid_voltage):.2f} V"
    )

    print(
        f"Average frequency      : "
        f"{calculate_average(grid_frequency):.3f} Hz"
    )

    print(
        f"Average power factor   : "
        f"{calculate_average(power_factor):.3f}"
    )

    # ========================================================
    # INVERTER
    # ========================================================

    print("\nINVERTER")
    print("----------------------------------------")

    print(
        f"Average inverter temp  : "
        f"{calculate_average(inverter_temperature):.2f} °C"
    )

    # ========================================================
    # SENSOR QUALITY
    # ========================================================

    print("\nSENSOR QUALITY")
    print("----------------------------------------")

    print(
        f"Missing voltage data   : "
        f"{missing_voltage}"
    )

    # ========================================================
    # FAULT DISTRIBUTION
    # ========================================================

    print("\nFAULT DISTRIBUTION")
    print("----------------------------------------")

    for fault, count in fault_counts.items():

        percentage = (
            count
            / total_records
        ) * 100

        print(
            f"{fault:25} "
            f"{count:4} "
            f"({percentage:5.1f}%)"
        )

    # ========================================================
    # FAULT SEVERITY
    # ========================================================

    print("\nFAULT SEVERITY")
    print("----------------------------------------")

    for severity in sorted(severity_counts):

        print(
            f"Level {severity}: "
            f"{severity_counts[severity]} records"
        )

    print()
    print("========================================")
    print("Analysis complete.")
    print("========================================")


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":

    dataset = load_dataset()

    analyze_dataset(dataset)