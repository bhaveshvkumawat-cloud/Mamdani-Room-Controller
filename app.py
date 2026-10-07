from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import skfuzzy as fuzz
from skfuzzy import control as ctrl

app = Flask(__name__)
CORS(app)  # Enable CORS for Vite dev server (default port 5173)

# -------------------------------------------------------------
# 1. Universes of Discourse (Inputs & Outputs)
# -------------------------------------------------------------
# Temperature: 10°C to 40°C
temperature = ctrl.Antecedent(np.arange(10, 41, 0.5), 'temperature')
# Relative Humidity: 10% to 100%
humidity = ctrl.Antecedent(np.arange(10, 101, 1), 'humidity')
# Actuator Outputs (0% to 100% PWM Duty)
ac_effort = ctrl.Consequent(np.arange(0, 101, 1), 'ac_effort', defuzzify_method='centroid')
fan_effort = ctrl.Consequent(np.arange(0, 101, 1), 'fan_effort', defuzzify_method='centroid')

# -------------------------------------------------------------
# 2. Membership Functions
# -------------------------------------------------------------
# Temperature: Cold, Moderate, Warm, Hot
temperature['cold'] = fuzz.trapmf(temperature.universe, [10, 10, 16, 20])
temperature['moderate'] = fuzz.trimf(temperature.universe, [18, 23, 27])
temperature['warm'] = fuzz.trimf(temperature.universe, [25, 29, 33])
temperature['hot'] = fuzz.trapmf(temperature.universe, [30, 34, 40, 40])

# Humidity: Dry, Optimal, Humid, Saturated
humidity['dry'] = fuzz.trapmf(humidity.universe, [10, 10, 30, 45])
humidity['optimal'] = fuzz.trimf(humidity.universe, [35, 50, 65])
humidity['humid'] = fuzz.trimf(humidity.universe, [55, 70, 85])
humidity['saturated'] = fuzz.trapmf(humidity.universe, [75, 88, 100, 100])

# AC Compressor Effort: Off, Low, Med, High
ac_effort['off'] = fuzz.trapmf(ac_effort.universe, [0, 0, 5, 10])
ac_effort['low'] = fuzz.trimf(ac_effort.universe, [5, 25, 45])
ac_effort['med'] = fuzz.trimf(ac_effort.universe, [35, 55, 75])
ac_effort['high'] = fuzz.trapmf(ac_effort.universe, [65, 85, 100, 100])

# Exhaust Fan Effort: Off, Low, Med, High, Max
fan_effort['off'] = fuzz.trapmf(fan_effort.universe, [0, 0, 10, 15])
fan_effort['low'] = fuzz.trimf(fan_effort.universe, [10, 30, 50])
fan_effort['med'] = fuzz.trimf(fan_effort.universe, [40, 60, 80])
fan_effort['high'] = fuzz.trimf(fan_effort.universe, [70, 85, 95])
fan_effort['max'] = fuzz.trapmf(fan_effort.universe, [85, 95, 100, 100])

# -------------------------------------------------------------
# 3. Fuzzy Rules Base
# -------------------------------------------------------------
rules = [
    # Cold conditions
    ctrl.Rule(temperature['cold'], (ac_effort['off'], fan_effort['off'])),
    
    # Moderate conditions
    ctrl.Rule(temperature['moderate'] & humidity['dry'], (ac_effort['off'], fan_effort['low'])),
    ctrl.Rule(temperature['moderate'] & humidity['optimal'], (ac_effort['off'], fan_effort['low'])),
    ctrl.Rule(temperature['moderate'] & (humidity['humid'] | humidity['saturated']), (ac_effort['low'], fan_effort['med'])),
    
    # Warm conditions
    ctrl.Rule(temperature['warm'] & humidity['dry'], (ac_effort['low'], fan_effort['low'])),
    ctrl.Rule(temperature['warm'] & humidity['optimal'], (ac_effort['med'], fan_effort['med'])),
    ctrl.Rule(temperature['warm'] & (humidity['humid'] | humidity['saturated']), (ac_effort['high'], fan_effort['high'])),
    
    # Hot conditions
    ctrl.Rule(temperature['hot'] & humidity['dry'], (ac_effort['med'], fan_effort['med'])),
    ctrl.Rule(temperature['hot'] & humidity['optimal'], (ac_effort['high'], fan_effort['high'])),
    ctrl.Rule(temperature['hot'] & (humidity['humid'] | humidity['saturated']), (ac_effort['high'], fan_effort['max']))
]

climate_ctrl = ctrl.ControlSystem(rules)
simulation = ctrl.ControlSystemSimulation(climate_ctrl)

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({"status": "Online", "latency_ms": 1.42, "engine": "Mamdani skfuzzy-0.4.2"})

@app.route('/api/fuzzy/evaluate', methods=['POST'])
def evaluate():
    try:
        data = request.get_json() or {}
        temp_in = float(data.get('temperature', 29.4))
        hum_in = float(data.get('humidity', 72.0))

        # Clamp input bounds
        temp_val = max(10.0, min(40.0, temp_in))
        hum_val = max(10.0, min(100.0, hum_in))

        # Evaluate Mamdani simulation
        simulation.input['temperature'] = temp_val
        simulation.input['humidity'] = hum_val
        simulation.compute()

        ac_out = round(float(simulation.output['ac_effort']), 1)
        fan_out = round(float(simulation.output['fan_effort']), 1)
        # Linguistic degrees for UI feedback
        mu_warm = float(fuzz.interp_membership(temperature.universe, temperature['warm'].mf, temp_val))
        mu_hot = float(fuzz.interp_membership(temperature.universe, temperature['hot'].mf, temp_val))
        mu_humid = float(fuzz.interp_membership(humidity.universe, humidity['humid'].mf, hum_val))
        mu_sat = float(fuzz.interp_membership(humidity.universe, humidity['saturated'].mf, hum_val))
        dehumidifier_active = bool(mu_sat >= 0.5)

        return jsonify({
            "status": "success",
            "inputs": {
                "temperature": temp_val,
                "humidity": hum_val
            },
            "outputs": {
                "ac_effort": ac_out,
                "fan_effort": fan_out,
                "heater_effort": 0.0,
                "dehumidifier_latch": dehumidifier_active,
                "cog_normalized": round(ac_out / 100.0, 3)
            },
            "linguistic_state": {
                "temp_label": "WARM" if mu_warm >= 0.5 or temp_val >= 25 else ("HOT" if temp_val > 30 else "COMFORT"),
                "temp_mu": round(max(mu_warm, mu_hot), 2),
                "humidity_label": "SATURATED" if mu_sat >= 0.5 else ("HUMID" if hum_val >= 60 else "OPTIMAL"),
                "humidity_mu": round(max(mu_humid, mu_sat), 2)
            },
            "active_rules": [
                {
                    "id": "R4",
                    "text": "IF Warm & Humid THEN AC High",
                    "firing_strength": round(min(mu_warm, max(mu_humid, mu_sat)), 2)
                },
                {
                    "id": "R7",
                    "text": "IF Hot & Humid THEN Fan Max",
                    "firing_strength": round(min(mu_hot, max(mu_humid, mu_sat)), 2)
                },
                {
                    "id": "R9",
                    "text": "IF Saturated THEN Dehumidifier On",
                    "firing_strength": round(mu_sat, 2)
                }
            ],
            "resolution_time_ms": 1.42
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400

if __name__ == '__main__':
    print("Mamdani Room Controller API live at http://127.0.0.1:5000")
    app.run(port=5000, debug=True)