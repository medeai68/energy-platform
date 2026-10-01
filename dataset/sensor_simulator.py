import random
import csv
from datetime import datetime, timedelta
from pathlib import Path


# ============================================================
# CONFIGURATION
# ============================================================

BASE_DIR = Path(__file__).parent
CSV_PATH = BASE_DIR / "sensor_data.csv"

NUMBER_OF_RECORDS = 1000

# Simulated sampling interval
SAMPLE_INTERVAL_SECONDS = 1


# ============================================================
# INITIAL CONDITIONS
# ============================================================

irradiance = 800.0
ambient_temperature = 25.0
panel_temperature = 35.0
humidity = 55.0
wind_speed = 3.0

voltage = 420.0
grid_voltage = 230.0
grid_frequency = 50.0

inverter_temperature = 40.0
energy_kwh = 0.0


# ============================================================
# FAULT PROBABILITIES
# ============================================================

FAULT_PROBABILITIES = {
    "normal": 0.40,
    "voltage_bias": 0.10,
    "voltage_drift": 0.10,
    "sensor_dropout": 0.08,
    "stuck_sensor": 0.07,
    "sensor_noise": 0.07,
    "panel_overheating": 0.06,
    "inverter_overheating": 0.05,
    "power_loss": 0.04,
    "grid_voltage_anomaly": 0.03,
}


# ============================================================
# FAULT FUNCTIONS
# ============================================================

def inject_voltage_bias(voltage, bias=30):
    return voltage + bias


def inject_voltage_drift(voltage, drift_amount):
    return voltage + drift_amount


def inject_sensor_dropout():
    return None


def inject_stuck_sensor(stuck_value=420):
    return stuck_value


def inject_sensor_noise(voltage, noise_level=15):
    return voltage + random.uniform(
        -noise_level,
        noise_level
    )


# ============================================================
# SELECT FAULT
# ============================================================

def select_fault():

    faults = list(
        FAULT_PROBABILITIES.keys()
    )

    probabilities = list(
        FAULT_PROBABILITIES.values()
    )

    return random.choices(
        faults,
        weights=probabilities,
        k=1
    )[0]


# ============================================================
# MAIN SIMULATION
# ============================================================

def generate_dataset():

    global irradiance
    global ambient_temperature
    global panel_temperature
    global humidity
    global wind_speed
    global voltage
    global grid_voltage
    global grid_frequency
    global inverter_temperature
    global energy_kwh


    # --------------------------------------------------------
    # STATE VARIABLES
    # --------------------------------------------------------

    voltage_drift = 0.0


    timestamp = datetime.now().replace(
        microsecond=0
    )


    # --------------------------------------------------------
    # STATISTICS
    # --------------------------------------------------------

    fault_counts = {
        fault: 0
        for fault in FAULT_PROBABILITIES
    }


    # ========================================================
    # CREATE CSV
    # ========================================================

    with open(
        CSV_PATH,
        "w",
        newline="",
        encoding="utf-8"
    ) as file:

        writer = csv.writer(file)


        # ----------------------------------------------------
        # CSV HEADER
        # ----------------------------------------------------

        writer.writerow([
            "timestamp",

            "irradiance",
            "ambient_temperature",
            "panel_temperature",
            "humidity",
            "wind_speed",

            "normal_voltage",
            "faulty_voltage",

            "current",

            "normal_power",
            "measured_power",

            "energy_kwh",

            "grid_voltage",
            "grid_frequency",
            "power_factor",

            "inverter_temperature",
            "inverter_status",

            "fault_type",
            "fault_severity"
        ])


        # ====================================================
        # GENERATE RECORDS
        # ====================================================

        for _ in range(NUMBER_OF_RECORDS):


            # =================================================
            # ENVIRONMENTAL CONDITIONS
            # =================================================

            # Irradiance
            irradiance += random.uniform(
                -20,
                20
            )

            irradiance = max(
                0,
                min(1000, irradiance)
            )


            # Ambient temperature
            ambient_temperature += random.uniform(
                -0.5,
                0.5
            )

            ambient_temperature = max(
                0,
                min(50, ambient_temperature)
            )


            # Humidity
            humidity += random.uniform(
                -1.5,
                1.5
            )

            humidity = max(
                20,
                min(95, humidity)
            )


            # Wind speed
            wind_speed += random.uniform(
                -0.5,
                0.5
            )

            wind_speed = max(
                0,
                min(20, wind_speed)
            )


            # =================================================
            # PANEL TEMPERATURE
            # =================================================

            # More sunlight → hotter panel
            target_panel_temperature = (
                ambient_temperature
                + irradiance * 0.025
            )

            panel_temperature += (
                target_panel_temperature
                - panel_temperature
            ) * 0.1

            # Wind provides cooling
            panel_temperature -= (
                wind_speed * 0.03
            )

            panel_temperature = max(
                0,
                min(90, panel_temperature)
            )


            # =================================================
            # NORMAL VOLTAGE
            # =================================================

            voltage += random.uniform(
                -2,
                2
            )

            voltage = max(
                300,
                min(500, voltage)
            )

            normal_voltage = voltage


            # =================================================
            # CURRENT
            # =================================================

            current = (
                irradiance / 1000
            ) * 20

            current += random.uniform(
                -0.2,
                0.2
            )

            current = max(
                0,
                current
            )


            # =================================================
            # POWER FACTOR
            # =================================================

            power_factor = random.uniform(
                0.94,
                0.99
            )


            # =================================================
            # GRID CONDITIONS
            # =================================================

            grid_voltage += random.uniform(
                -0.5,
                0.5
            )

            grid_voltage = max(
                210,
                min(250, grid_voltage)
            )


            grid_frequency += random.uniform(
                -0.03,
                0.03
            )

            grid_frequency = max(
                49.5,
                min(50.5, grid_frequency)
            )


            # =================================================
            # INVERTER TEMPERATURE
            # =================================================

            target_inverter_temperature = (
                30
                + (irradiance / 1000) * 30
            )

            inverter_temperature += (
                target_inverter_temperature
                - inverter_temperature
            ) * 0.1

            inverter_temperature += random.uniform(
                -0.3,
                0.3
            )

            inverter_temperature = max(
                20,
                min(100, inverter_temperature)
            )


            # =================================================
            # FAULT SELECTION
            # =================================================

            fault = select_fault()

            fault_severity = 0

            faulty_voltage = normal_voltage

            measured_current = current

            measured_grid_voltage = grid_voltage

            measured_panel_temperature = (
                panel_temperature
            )

            measured_inverter_temperature = (
                inverter_temperature
            )

            inverter_status = "normal"


            # =================================================
            # FAULT INJECTION
            # =================================================

            if fault == "normal":

                voltage_drift = 0

                fault_severity = 0


            elif fault == "voltage_bias":

                faulty_voltage = inject_voltage_bias(
                    normal_voltage
                )

                voltage_drift = 0

                fault_severity = 2


            elif fault == "voltage_drift":

                voltage_drift += random.uniform(
                    0.5,
                    2.0
                )

                voltage_drift = min(
                    voltage_drift,
                    40
                )

                faulty_voltage = (
                    inject_voltage_drift(
                        normal_voltage,
                        voltage_drift
                    )
                )

                fault_severity = (
                    1
                    if voltage_drift < 15
                    else 2
                )


            elif fault == "sensor_dropout":

                faulty_voltage = (
                    inject_sensor_dropout()
                )

                fault_severity = 3


            elif fault == "stuck_sensor":

                faulty_voltage = (
                    inject_stuck_sensor()
                )

                fault_severity = 2


            elif fault == "sensor_noise":

                faulty_voltage = (
                    inject_sensor_noise(
                        normal_voltage
                    )
                )

                fault_severity = 1


            elif fault == "panel_overheating":

                measured_panel_temperature = (
                    random.uniform(
                        70,
                        90
                    )
                )

                fault_severity = 2


            elif fault == "inverter_overheating":

                measured_inverter_temperature = (
                    random.uniform(
                        80,
                        100
                    )
                )

                inverter_status = "overheating"

                fault_severity = 3


            elif fault == "power_loss":

                measured_current = (
                    current * random.uniform(
                        0.4,
                        0.7
                    )
                )

                fault_severity = 2


            elif fault == "grid_voltage_anomaly":

                measured_grid_voltage = (
                    random.choice([
                        random.uniform(190, 210),
                        random.uniform(250, 270)
                    ])
                )

                fault_severity = 2


            # =================================================
            # NORMAL POWER
            # =================================================

            normal_power = (
                normal_voltage
                * current
                * power_factor
            )


            # =================================================
            # MEASURED POWER
            # =================================================

            if faulty_voltage is None:

                measured_power = None

            else:

                measured_power = (
                    faulty_voltage
                    * measured_current
                    * power_factor
                )


            # =================================================
            # ENERGY
            # =================================================

            if measured_power is not None:

                energy_kwh += (
                    measured_power
                    * SAMPLE_INTERVAL_SECONDS
                    / 3_600_000
                )


            # =================================================
            # SAVE RECORD
            # =================================================

            writer.writerow([

                timestamp.strftime(
                    "%Y-%m-%d %H:%M:%S"
                ),

                round(irradiance, 2),

                round(
                    ambient_temperature,
                    2
                ),

                round(
                    measured_panel_temperature,
                    2
                ),

                round(humidity, 2),

                round(wind_speed, 2),

                round(normal_voltage, 2),

                (
                    round(faulty_voltage, 2)
                    if faulty_voltage is not None
                    else None
                ),

                round(
                    measured_current,
                    2
                ),

                round(
                    normal_power,
                    2
                ),

                (
                    round(measured_power, 2)
                    if measured_power is not None
                    else None
                ),

                round(
                    energy_kwh,
                    6
                ),

                round(
                    measured_grid_voltage,
                    2
                ),

                round(
                    grid_frequency,
                    3
                ),

                round(
                    power_factor,
                    3
                ),

                round(
                    measured_inverter_temperature,
                    2
                ),

                inverter_status,

                fault,

                fault_severity
            ])


            # -------------------------------------------------
            # STATISTICS
            # -------------------------------------------------

            fault_counts[fault] += 1


            # -------------------------------------------------
            # NEXT TIMESTAMP
            # -------------------------------------------------

            timestamp += timedelta(
                seconds=SAMPLE_INTERVAL_SECONDS
            )


    # ========================================================
    # SUMMARY
    # ========================================================

    print()
    print("========================================")
    print("SOLAR ENERGY SIMULATION COMPLETE")
    print("========================================")

    print(
        f"Records generated : "
        f"{NUMBER_OF_RECORDS}"
    )

    print(
        f"Dataset saved to  : "
        f"{CSV_PATH}"
    )

    print()
    print("Fault distribution:")
    print("----------------------------------------")


    for fault, count in fault_counts.items():

        percentage = (
            count
            / NUMBER_OF_RECORDS
        ) * 100

        print(
            f"{fault:25} "
            f"{count:4} "
            f"({percentage:5.1f}%)"
        )


    print()
    print("Simulation finished.")
    print("========================================")


# ============================================================
# PROGRAM ENTRY POINT
# ============================================================

if __name__ == "__main__":

    generate_dataset()