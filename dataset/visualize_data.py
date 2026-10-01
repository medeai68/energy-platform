import csv
from pathlib import Path

import matplotlib.pyplot as plt


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
# VISUALIZATION
# ============================================================

def visualize():

    data = load_dataset()

    if not data:

        print("No data available.")
        return

    x = range(len(data))

    # ========================================================
    # EXTRACT DATA
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

    grid_voltage = [
        to_float(row["grid_voltage"])
        for row in data
    ]

    grid_frequency = [
        to_float(row["grid_frequency"])
        for row in data
    ]

    inverter_temperature = [
        to_float(row["inverter_temperature"])
        for row in data
    ]

    # ========================================================
    # 1. IRRADIANCE
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        irradiance
    )

    plt.title("Solar Irradiance")
    plt.xlabel("Sample")
    plt.ylabel("Irradiance (W/m²)")
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    # ========================================================
    # 2. TEMPERATURE
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        ambient_temperature,
        label="Ambient Temperature"
    )

    plt.plot(
        x,
        panel_temperature,
        label="Panel Temperature"
    )

    plt.title("Ambient vs Panel Temperature")
    plt.xlabel("Sample")
    plt.ylabel("Temperature (°C)")
    plt.legend()
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    # ========================================================
    # 3. HUMIDITY
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        humidity
    )

    plt.title("Humidity")
    plt.xlabel("Sample")
    plt.ylabel("Humidity (%)")
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    # ========================================================
    # 4. WIND SPEED
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        wind_speed
    )

    plt.title("Wind Speed")
    plt.xlabel("Sample")
    plt.ylabel("Wind Speed (m/s)")
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    # ========================================================
    # 5. VOLTAGE
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        normal_voltage,
        label="Normal Voltage"
    )

    plt.plot(
        x,
        faulty_voltage,
        label="Measured Voltage"
    )

    plt.title("Normal vs Measured Voltage")
    plt.xlabel("Sample")
    plt.ylabel("Voltage (V)")
    plt.legend()
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    # ========================================================
    # 6. CURRENT
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        current
    )

    plt.title("Solar Current")
    plt.xlabel("Sample")
    plt.ylabel("Current (A)")
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    # ========================================================
    # 7. POWER
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        normal_power,
        label="Normal Power"
    )

    plt.plot(
        x,
        measured_power,
        label="Measured Power"
    )

    plt.title("Normal vs Measured Power")
    plt.xlabel("Sample")
    plt.ylabel("Power (W)")
    plt.legend()
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    # ========================================================
    # 8. GRID VOLTAGE
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        grid_voltage
    )

    plt.title("Grid Voltage")
    plt.xlabel("Sample")
    plt.ylabel("Grid Voltage (V)")
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    # ========================================================
    # 9. GRID FREQUENCY
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        grid_frequency
    )

    plt.title("Grid Frequency")
    plt.xlabel("Sample")
    plt.ylabel("Frequency (Hz)")
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    # ========================================================
    # 10. INVERTER TEMPERATURE
    # ========================================================

    plt.figure(figsize=(12, 5))

    plt.plot(
        x,
        inverter_temperature
    )

    plt.title("Inverter Temperature")
    plt.xlabel("Sample")
    plt.ylabel("Temperature (°C)")
    plt.grid(True)

    plt.tight_layout()
    plt.show()

    print()
    print("========================================")
    print("VISUALIZATION COMPLETE")
    print("========================================")


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":

    visualize()