import React, { useState, useEffect, useMemo } from 'react';

export default function FuzzyRoomControllerStudio() {
  const [temperature, setTemperature] = useState(29.4);
  const [humidity, setHumidity] = useState(72);
  const [temperatureSetpoint, setTemperatureSetpoint] = useState(24);
  const [humiditySetpoint, setHumiditySetpoint] = useState(50);
  const [isAuto, setIsAuto] = useState(true);
  const [apiOnline, setApiOnline] = useState(false);
  const [apiEvaluation, setApiEvaluation] = useState(null);
  const [latency, setLatency] = useState(120);
  const [activePreset, setActivePreset] = useState('Hot & Humid Summer');
  const [activeView, setActiveView] = useState('controller');
  const [manualAcEffort, setManualAcEffort] = useState(50);
  const [manualFanEffort, setManualFanEffort] = useState(40);
  const [manualDehumidifierOn, setManualDehumidifierOn] = useState(false);
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [trajectory, setTrajectory] = useState([29.4]);

  // Environmental presets
  const PRESETS = [
    { name: 'Hot & Humid Summer', temp: 29.4, hum: 72 },
    { name: 'Dry Winter', temp: 16.5, hum: 28 },
    { name: 'Optimal Spring', temp: 23.0, hum: 48 },
    { name: 'Monsoon', temp: 31.0, hum: 88 },
  ];

  // Client-side Mamdani triangular/trapezoidal approximation fallback
  const fuzzyComputation = useMemo(() => {
    // Triangular / trapezoidal membership functions
    const trimf = (x, a, b, c) => Math.max(0, Math.min((x - a) / (b - a || 1e-6), (c - x) / (c - b || 1e-6)));
    const trapmf = (x, a, b, c, d) => Math.max(0, Math.min(Math.min((x - a) / (b - a || 1e-6), 1), (d - x) / (d - c || 1e-6)));

    const muCold = trapmf(temperature, 10, 10, 16, 20);
    const muComfort = trimf(temperature, 18, 23, 27);
    const muWarm = trimf(temperature, 24, 28, 33);
    const muHot = trapmf(temperature, 30, 34, 40, 40);

    const muDry = trapmf(humidity, 10, 10, 30, 45);
    const muOpt = trimf(humidity, 35, 50, 65);
    const muHumid = trimf(humidity, 55, 70, 85);
    const muSat = trapmf(humidity, 75, 88, 100, 100);

    // Rule firing strengths (Mamdani Min operator)
    const r4Strength = Math.min(muWarm, Math.max(muHumid, muSat));
    const r7Strength = Math.min(muHot, Math.max(muHumid, muSat));
    const r9Strength = muSat;

    // Defuzzified centroid outputs (COG approximation)
    const acEffort = Math.min(100, Math.max(0, 
      (muWarm * 55 + muHot * 90 + muHumid * 30 + muSat * 40) /
      (muWarm + muHot + muHumid + muSat + 0.1) * 0.95
    ));

    const fanEffort = Math.min(100, Math.max(0, 
      (muHumid * 75 + muSat * 95 + muHot * 80 + muWarm * 40) / 
      (muHumid + muSat + muHot + muWarm + 0.1) * 0.92
    ));

    const dehumidifierOn = r9Strength >= 0.5;

    return {
      muWarm,
      muHumid,
      acEffort: Number(acEffort.toFixed(1)),
      fanEffort: Number(fanEffort.toFixed(1)),
      cogNorm: Number((acEffort / 100).toFixed(3)),
      dehumidifierOn,
      r4Strength: Number(r4Strength.toFixed(2)),
      r7Strength: Number(r7Strength.toFixed(2)),
      r9Strength: Number(r9Strength.toFixed(2))
    };
  }, [temperature, humidity]);

  // Optional: Connect to live Flask API if active
  useEffect(() => {
    let isMounted = true;
    const requestStarted = performance.now();

    fetch('http://127.0.0.1:5000/api/fuzzy/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temperature, humidity })
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          if (data?.status !== 'success') throw new Error('Fuzzy evaluation failed');
          setApiEvaluation(data);
          setApiOnline(true);
          setLatency(Math.max(1, Math.round(performance.now() - requestStarted)));
        }
      })
      .catch(() => {
        if (isMounted) {
          setApiOnline(false);
          setApiEvaluation(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [temperature, humidity]);

  const controllerMetrics = useMemo(() => {
    if (!apiEvaluation) return fuzzyComputation;
    const strengths = Object.fromEntries(
      apiEvaluation.active_rules.map((rule) => [rule.id, rule.firing_strength])
    );
    return {
      ...fuzzyComputation,
      acEffort: apiEvaluation.outputs.ac_effort,
      fanEffort: apiEvaluation.outputs.fan_effort,
      dehumidifierOn: apiEvaluation.outputs.dehumidifier_latch,
      cogNorm: apiEvaluation.outputs.cog_normalized,
      r4Strength: strengths.R4 ?? 0,
      r7Strength: strengths.R7 ?? 0,
      r9Strength: strengths.R9 ?? 0,
    };
  }, [apiEvaluation, fuzzyComputation]);

  useEffect(() => {
    if (!simulationRunning) return undefined;

    const timer = window.setInterval(() => {
      const acOutput = isAuto ? controllerMetrics.acEffort : manualAcEffort;
      setTemperature((current) => current <= temperatureSetpoint
        ? current
        : Number(Math.max(temperatureSetpoint, current - acOutput / 100 * 0.2).toFixed(1)));
      const dehumidifierOutput = isAuto ? controllerMetrics.dehumidifierOn : manualDehumidifierOn;
      setHumidity((current) => current <= humiditySetpoint
        ? current
        : Math.max(humiditySetpoint, Math.round(current - (dehumidifierOutput ? 1 : 0))));
      setTrajectory((points) => [...points.slice(-29), temperature]);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [simulationRunning, isAuto, controllerMetrics, manualAcEffort, manualDehumidifierOn, temperature, temperatureSetpoint, humiditySetpoint]);

  const navItems = [
    { id: 'controller', label: 'Real-Time Controller' },
    { id: 'rules', label: 'Membership Functions & Rules' },
    { id: 'diagnostics', label: 'Simulation & Diagnostics' },
    { id: 'config', label: 'System Config' },
  ];

  const applyPreset = (preset) => {
    setSimulationRunning(false);
    setActivePreset(preset.name);
    setTemperature(preset.temp);
    setHumidity(preset.hum);
    setTrajectory([preset.temp]);
  };

  const effectiveAcEffort = isAuto ? controllerMetrics.acEffort : manualAcEffort;
  const effectiveFanEffort = isAuto ? controllerMetrics.fanEffort : manualFanEffort;
  const effectiveDehumidifierOn = isAuto ? controllerMetrics.dehumidifierOn : manualDehumidifierOn;
  const temperatureLabel = apiEvaluation?.linguistic_state.temp_label ?? (fuzzyComputation.muWarm > 0.5 ? 'WARM' : 'COMFORT');
  const temperatureMembership = apiEvaluation?.linguistic_state.temp_mu ?? fuzzyComputation.muWarm;
  const humidityLabel = apiEvaluation?.linguistic_state.humidity_label ?? (fuzzyComputation.muHumid > 0.5 ? 'HUMID' : 'OPTIMAL');
  const humidityMembership = apiEvaluation?.linguistic_state.humidity_mu ?? fuzzyComputation.muHumid;
  const activeRuleCount = [controllerMetrics.r4Strength, controllerMetrics.r7Strength, controllerMetrics.r9Strength]
    .filter((strength) => strength > 0).length;
  const trajectoryPoints = trajectory.map((value, index) => {
    const x = 20 + index / Math.max(trajectory.length - 1, 1) * 460;
    const y = 110 - (Math.min(36, Math.max(14, value)) - 14) / 22 * 90;
    return `${x},${y}`;
  }).join(' ');
  const trajectoryCurrentX = 20 + (trajectory.length - 1) / Math.max(trajectory.length - 1, 1) * 460;
  const trajectoryCurrentY = trajectoryPoints.split(' ').at(-1)?.split(',')[1] ?? '110';
  const setpointY = 110 - (temperatureSetpoint - 14) / 22 * 90;

  const resetSimulation = () => {
    setSimulationRunning(false);
    setTrajectory([temperature]);
  };

  const renderSecondaryPanel = () => {
    if (activeView === 'rules') {
      return (
        <main className="max-w-5xl mx-auto p-6">
          <div className="rounded-2xl border border-[#2a3748] bg-[#121922] p-6">
            <h2 className="text-xl font-bold text-white">Membership Functions & Rules</h2>
            <div className="mt-5 grid gap-3 md:grid-cols-2 text-sm text-slate-300">
              <div className="rounded-lg border border-[#223042] bg-[#0d141b] p-4">
                <h3 className="font-semibold text-amber-300">Temperature memberships</h3>
                <p className="mt-2">Cold: 10-20°C · Comfort: 18-27°C</p>
                <p>Warm: 24-33°C · Hot: 30-40°C</p>
              </div>
              <div className="rounded-lg border border-[#223042] bg-[#0d141b] p-4">
                <h3 className="font-semibold text-cyan-300">Humidity memberships</h3>
                <p className="mt-2">Dry: 10-45% · Optimal: 35-65%</p>
                <p>Humid: 55-85% · Saturated: 75-100%</p>
              </div>
            </div>
            <div className="mt-5 space-y-2 font-mono text-sm">
              {[
                ['R4', 'IF Warm AND Humid THEN AC High', controllerMetrics.r4Strength],
                ['R7', 'IF Hot AND Humid THEN Fan Max', controllerMetrics.r7Strength],
                ['R9', 'IF Saturated THEN Dehumidifier On', controllerMetrics.r9Strength],
              ].map(([id, text, strength]) => (
                <div key={id} className="flex items-center justify-between gap-4 rounded-lg border border-[#223042] bg-[#0d141b] p-3">
                  <span className="text-slate-300"><strong className="text-cyan-300">{id}:</strong> {text}</span>
                  <span className={strength > 0 ? 'text-emerald-300' : 'text-slate-500'}>μ = {strength.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        </main>
      );
    }

    if (activeView === 'diagnostics') {
      return (
        <main className="max-w-5xl mx-auto p-6">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-[#2a3748] bg-[#121922] p-6">
              <h2 className="text-xl font-bold text-white">Simulation & Diagnostics</h2>
              <p className="mt-2 text-sm text-slate-400">Room-model simulation only; no physical HVAC equipment is connected.</p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => {
                    if (!simulationRunning) setTrajectory([temperature]);
                    setSimulationRunning((running) => !running);
                  }}
                  className="rounded border border-cyan-400/50 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-200 hover:bg-cyan-500/20"
                >
                  {simulationRunning ? 'Pause simulation' : 'Start simulation'}
                </button>
                <button
                  onClick={resetSimulation}
                  className="rounded border border-[#344256] px-4 py-2 text-sm text-slate-300 hover:border-slate-400"
                >
                  Reset
                </button>
                <span className={`text-xs font-mono ${simulationRunning ? 'text-emerald-300' : 'text-slate-500'}`}>
                  {simulationRunning ? 'RUNNING' : 'STOPPED'}
                </span>
              </div>
              <div className="mt-5 space-y-4 text-sm text-slate-300">
                <div className="flex justify-between"><span>Model</span><span className="text-cyan-300">Mamdani Min–Max</span></div>
                <div className="flex justify-between"><span>Mode</span><span className="text-cyan-300">{isAuto ? 'Auto' : 'Manual'}</span></div>
                <div className="flex justify-between"><span>API</span><span className={apiOnline ? 'text-emerald-300' : 'text-amber-300'}>{apiOnline ? 'Online' : 'Simulated'}</span></div>
                <div className="flex justify-between"><span>Latency</span><span>{latency} ms</span></div>
                <div className="flex justify-between"><span>Temperature</span><span>{temperature.toFixed(1)} °C</span></div>
                <div className="flex justify-between"><span>Humidity</span><span>{humidity}% RH</span></div>
                <div className="flex justify-between"><span>AC command</span><span>{effectiveAcEffort.toFixed(1)}%</span></div>
                <div className="flex justify-between"><span>Fan command</span><span>{effectiveFanEffort.toFixed(1)}%</span></div>
              </div>
            </div>

            <div className="rounded-2xl border border-[#2a3748] bg-[#121922] p-6">
              <h2 className="text-xl font-bold text-white">Rule Trace</h2>
              <div className="mt-5 space-y-3 text-sm font-mono text-slate-300">
                <div className="flex justify-between border-b border-[#1f2d3a] pb-2"><span>R4</span><span>{controllerMetrics.r4Strength.toFixed(2)}</span></div>
                <div className="flex justify-between border-b border-[#1f2d3a] pb-2"><span>R7</span><span>{controllerMetrics.r7Strength.toFixed(2)}</span></div>
                <div className="flex justify-between border-b border-[#1f2d3a] pb-2"><span>R9</span><span>{controllerMetrics.r9Strength.toFixed(2)}</span></div>
                <div className="flex justify-between"><span>COG</span><span>{controllerMetrics.acEffort.toFixed(1)}%</span></div>
              </div>
            </div>
          </div>
        </main>
      );
    }

    return (
      <main className="max-w-4xl mx-auto p-6">
        <div className="rounded-2xl border border-[#2a3748] bg-[#121922] p-6">
          <h2 className="text-xl font-bold text-white">System Config</h2>
          <div className="mt-6 space-y-4 text-sm text-slate-300">
            <div className="flex items-center justify-between rounded-lg border border-[#223042] bg-[#0d141b] p-3">
              <span>Control mode</span>
              <span className="font-medium text-cyan-300">{isAuto ? 'Automatic' : 'Manual Override'}</span>
            </div>
            <label className="block rounded-lg border border-[#223042] bg-[#0d141b] p-3">
              <span className="flex justify-between"><span>Temperature setpoint</span><span className="font-medium text-cyan-300">{temperatureSetpoint.toFixed(1)} °C</span></span>
              <input type="range" min="18" max="28" step="0.5" value={temperatureSetpoint} onChange={(event) => setTemperatureSetpoint(Number(event.target.value))} className="mt-3 w-full accent-cyan-400" />
            </label>
            <label className="block rounded-lg border border-[#223042] bg-[#0d141b] p-3">
              <span className="flex justify-between"><span>Humidity setpoint</span><span className="font-medium text-cyan-300">{humiditySetpoint}% RH</span></span>
              <input type="range" min="35" max="65" step="1" value={humiditySetpoint} onChange={(event) => setHumiditySetpoint(Number(event.target.value))} className="mt-3 w-full accent-cyan-400" />
            </label>
            <div className="flex items-center justify-between rounded-lg border border-[#223042] bg-[#0d141b] p-3">
              <span>Dehumidifier output</span>
              <span className="font-medium text-cyan-300">{effectiveDehumidifierOn ? 'ON' : 'OFF'}</span>
            </div>
          </div>
        </div>
      </main>
    );
  };

  return (
    <div className="min-h-screen bg-[#0e141b] text-slate-100 font-['Space_Grotesk',sans-serif] selection:bg-cyan-500/30">
      <header className="h-16 border-b border-[#222a36] bg-[#090f16]/90 backdrop-blur px-6 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded bg-gradient-to-tr from-cyan-500 to-teal-300 flex items-center justify-center font-bold text-black text-xs shadow-lg shadow-cyan-500/20">
              μ
            </div>
            <span className="font-bold tracking-tight text-white text-base">
              Mamdani-Room-Controller
            </span>
            <span className="text-[10px] font-mono uppercase bg-[#18212c] px-2 py-0.5 rounded border border-[#2a3648] text-cyan-400">
              Vite + Flask
            </span>
          </div>

          <nav className="hidden md:flex items-center gap-1 ml-6 text-xs text-slate-400">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id)}
                className={`px-3 py-1.5 rounded transition ${
                  activeView === item.id
                    ? 'text-cyan-400 font-medium bg-[#141d27] border border-cyan-500/30'
                    : 'hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs font-mono bg-[#111923] px-3 py-1.5 rounded border border-[#1f2b3b]">
            <span className={`w-2 h-2 rounded-full ${apiOnline ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-amber-400'}`}></span>
            <span className="text-slate-400">Flask API:</span>
            <span className={apiOnline ? 'text-emerald-300' : 'text-amber-300'}>
              {apiOnline ? 'Online' : 'Simulated'}
            </span>
            <span className="text-slate-500">/ {latency}ms</span>
          </div>

          <div className="bg-[#121a24] p-0.5 rounded border border-[#222e3f] flex text-xs">
            <button
              onClick={() => setIsAuto(true)}
              className={`px-3 py-1 rounded font-medium transition ${isAuto ? 'bg-cyan-500 text-black shadow' : 'text-slate-400 hover:text-white'}`}
            >
              Auto
            </button>
            <button
              onClick={() => setIsAuto(false)}
              className={`px-3 py-1 rounded font-medium transition ${!isAuto ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              Manual
            </button>
          </div>
        </div>
      </header>

      {activeView === 'controller' ? (
        <main className="max-w-7xl mx-auto p-6 space-y-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-cyan-400">
                <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                Mamdani Closed-Loop Engine
              </div>
              <h1 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight mt-1">
                Climate Automation Core
              </h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Intelligent multi-variable fuzzy inference with real-time centroid defuzzification.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  onClick={() => applyPreset(p)}
                  className={`text-xs px-3.5 py-1.5 rounded border transition ${
                    activePreset === p.name
                      ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300 shadow-sm'
                      : 'border-[#243144] bg-[#111822] text-slate-400 hover:border-slate-500 hover:text-slate-200'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-[#121922] border border-[#222e3f] rounded-xl p-5 relative overflow-hidden">
              <div className="flex justify-between items-center text-xs font-mono text-slate-400 mb-2">
                <span>AMBIENT TEMPERATURE</span>
                <span className="text-amber-400">🌡️</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-extrabold tracking-tight text-white">{temperature.toFixed(1)}</span>
                <span className="text-xl text-slate-400 font-medium">°C</span>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs">
                <span className="bg-amber-500/10 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded font-mono font-medium">
                  {temperatureLabel} [μ={temperatureMembership.toFixed(2)}]
                </span>
                <span className="text-slate-500 font-mono">Target {temperatureSetpoint.toFixed(1)}°C</span>
              </div>
            </div>

            <div className="bg-[#121922] border border-[#222e3f] rounded-xl p-5 relative overflow-hidden">
              <div className="flex justify-between items-center text-xs font-mono text-slate-400 mb-2">
                <span>RELATIVE HUMIDITY</span>
                <span className="text-cyan-400">💧</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-extrabold tracking-tight text-white">{humidity}</span>
                <span className="text-xl text-slate-400 font-medium">%RH</span>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs">
                <span className="bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 px-2 py-0.5 rounded font-mono font-medium">
                  {humidityLabel} [μ={humidityMembership.toFixed(2)}]
                </span>
                <span className="text-slate-500 font-mono">Comfort: 40-60%</span>
              </div>
            </div>

            <div className="bg-[#121922] border border-[#222e3f] rounded-xl p-5 relative overflow-hidden">
              <div className="flex justify-between items-center text-xs font-mono text-slate-400 mb-2">
                <span>{isAuto ? 'DEFUZZIFIED EFFORT (COG)' : 'MANUAL AC OUTPUT'}</span>
                <span className="text-emerald-400">⚡</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-extrabold tracking-tight text-white">{effectiveAcEffort.toFixed(1)}</span>
                <span className="text-xl text-slate-400 font-medium">%</span>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-emerald-400 font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                  <span>{isAuto ? 'Cooling Demanded' : 'Manual Override'}</span>
                </div>
                <span className="text-slate-500 font-mono">{isAuto ? `Z* = ${controllerMetrics.cogNorm.toFixed(3)}` : 'Operator setpoint'}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 space-y-6">
              <div className="bg-[#121922] border border-[#222e3f] rounded-xl p-5 space-y-5">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-white text-base">Crisp Input Adjustments</h3>
                  <span className="text-[11px] font-mono text-slate-400 bg-[#192330] px-2 py-0.5 rounded border border-[#29384d]">
                    {isAuto ? '⟳ Live Loop' : 'Manual'}
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-slate-300 font-medium">
                      <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                      Temperature
                    </span>
                    <span className="font-mono font-bold text-amber-400">{temperature.toFixed(1)} °C</span>
                  </div>
                  <input
                    type="range"
                    min="14"
                    max="36"
                    step="0.1"
                    value={temperature}
                    onChange={(e) => setTemperature(parseFloat(e.target.value))}
                    className="w-full accent-cyan-400 cursor-pointer h-2 bg-[#1d2735] rounded-lg"
                  />
                  <div className="flex justify-between text-[10px] font-mono text-slate-500">
                    <span>14°C Freezing</span>
                    <span>24°C Comfort</span>
                    <span>36°C Hot</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-slate-300 font-medium">
                      <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                      Relative Humidity
                    </span>
                    <span className="font-mono font-bold text-cyan-400">{humidity} %RH</span>
                  </div>
                  <input
                    type="range"
                    min="15"
                    max="95"
                    step="1"
                    value={humidity}
                    onChange={(e) => setHumidity(parseInt(e.target.value))}
                    className="w-full accent-cyan-400 cursor-pointer h-2 bg-[#1d2735] rounded-lg"
                  />
                  <div className="flex justify-between text-[10px] font-mono text-slate-500">
                    <span>15% Dry</span>
                    <span>{humiditySetpoint}% Target</span>
                    <span>95% Saturated</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-[#1e2a3a] space-y-2.5">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-mono uppercase text-slate-400 text-[11px]">Active Firing Rules</span>
                    <span className="text-[11px] font-mono text-cyan-400">{activeRuleCount} Rules Firing</span>
                  </div>

                  <div className="space-y-1.5 text-xs font-mono">
                    <div className="p-2 rounded bg-[#0b1016] border border-[#1b2636] flex items-center justify-between">
                      <span className="text-slate-300">
                        <strong className="text-amber-400">R4:</strong> IF Warm & Humid THEN AC <span className="text-cyan-300 font-bold">High</span>
                      </span>
                      <span className="text-amber-400 font-bold">{controllerMetrics.r4Strength.toFixed(2)}</span>
                    </div>

                    <div className="p-2 rounded bg-[#0b1016] border border-[#1b2636] flex items-center justify-between">
                      <span className="text-slate-400">
                        <strong className="text-slate-500">R7:</strong> IF Hot & Humid THEN Fan Max
                      </span>
                      <span className={controllerMetrics.r7Strength > 0 ? 'text-emerald-300 font-bold' : 'text-slate-600 font-bold'}>{controllerMetrics.r7Strength.toFixed(2)}</span>
                    </div>

                    <div className="p-2 rounded bg-[#0b1016] border border-[#1b2636] flex items-center justify-between">
                      <span className="text-slate-400">
                        <strong className="text-slate-500">R9:</strong> IF Saturated THEN Dehumidifier On
                      </span>
                      <span className={controllerMetrics.r9Strength > 0 ? 'text-emerald-300 font-bold' : 'text-slate-600 font-bold'}>{controllerMetrics.r9Strength.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="lg:col-span-7 bg-[#121922] border border-[#222e3f] rounded-xl p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-bold text-white text-base">Defuzzification Composition</h3>
                  <span className="text-[10px] font-mono text-slate-400 bg-[#1b2533] px-2 py-0.5 rounded border border-[#263548]">
                    Method: COG (Center of Gravity)
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  Aggregated Mamdani output membership surface & center-of-gravity integration
                </p>
              </div>

              <div className="relative my-4 bg-[#090f16] rounded-lg border border-[#1d2939] p-4 h-48 flex items-center justify-center">
                <svg className="w-full h-full overflow-visible" viewBox="0 0 400 150">
                  <line x1="20" y1="130" x2="380" y2="130" stroke="#1f2c3d" strokeWidth="1" />
                  <line x1="20" y1="20" x2="380" y2="20" stroke="#172230" strokeDasharray="3 3" />
                  <polygon points="20,130 60,70 120,130" fill="none" stroke="#233448" strokeWidth="1" strokeDasharray="2 2" />
                  <polygon points="100,130 180,60 260,130" fill="none" stroke="#233448" strokeWidth="1" strokeDasharray="2 2" />
                  <polygon points="220,130 310,40 380,130" fill="none" stroke="#233448" strokeWidth="1" strokeDasharray="2 2" />
                  <polygon
                    points="20,130 140,130 220,95 280,60 380,60 380,130"
                    fill="url(#cyanGlow)"
                    stroke="#00e5ff"
                    strokeWidth="2"
                  />
                  <line
                    x1={40 + effectiveAcEffort * 3.3}
                    y1="25"
                    x2={40 + effectiveAcEffort * 3.3}
                    y2="130"
                    stroke="#fbbf24"
                    strokeWidth="2.5"
                    strokeDasharray="4 3"
                  />
                  <circle
                    cx={40 + effectiveAcEffort * 3.3}
                    cy="60"
                    r="4"
                    fill="#fbbf24"
                  />
                  <defs>
                    <linearGradient id="cyanGlow" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00e5ff" stopOpacity="0.3" />
                      <stop offset="100%" stopColor="#00e5ff" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                </svg>

                <div
                  className="absolute top-6 font-mono text-[11px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded shadow"
                  style={{ left: `${Math.min(80, Math.max(20, effectiveAcEffort))}%` }}
                >
                  COG: {effectiveAcEffort.toFixed(1)}%
                </div>

                <div className="absolute bottom-1 left-6 right-6 flex justify-between text-[10px] font-mono text-slate-500">
                  <span>0% (Idle)</span>
                  <span>50% (Nominal)</span>
                  <span>100% (Maximum)</span>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs font-mono text-slate-500 pt-2 border-t border-[#1b2737]">
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <span>✔</span> Inference Resolution: {(apiEvaluation?.resolution_time_ms ?? latency).toFixed(2)}ms
                </span>
                <span>Output domain: [0 - 100%]</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-5 bg-[#121922] border border-[#222e3f] rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-white text-base">Actuator Duty Status</h3>
                <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded">
                  MODEL OUTPUTS
                </span>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-slate-300">Inverter AC Compressor</span>
                  <span className="text-emerald-400 font-bold">{effectiveAcEffort.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-[#0a0f16] h-2.5 rounded-full overflow-hidden border border-[#1b2636]">
                  <div
                    className="bg-gradient-to-r from-teal-400 to-emerald-400 h-full rounded-full transition-all duration-300"
                    style={{ width: `${effectiveAcEffort}%` }}
                  ></div>
                </div>
              </div>

              {!isAuto && (
                <div className="space-y-4 border-y border-[#1a2535] py-3">
                  <label className="block space-y-1.5 text-xs font-mono text-slate-300">
                    <span className="flex justify-between"><span>Manual AC output</span><span>{manualAcEffort}%</span></span>
                    <input type="range" min="0" max="100" value={manualAcEffort} onChange={(event) => setManualAcEffort(Number(event.target.value))} className="w-full accent-cyan-400" />
                  </label>
                  <label className="block space-y-1.5 text-xs font-mono text-slate-300">
                    <span className="flex justify-between"><span>Manual fan output</span><span>{manualFanEffort}%</span></span>
                    <input type="range" min="0" max="100" value={manualFanEffort} onChange={(event) => setManualFanEffort(Number(event.target.value))} className="w-full accent-cyan-400" />
                  </label>
                  <label className="flex items-center gap-2 text-xs font-mono text-slate-300">
                    <input type="checkbox" checked={manualDehumidifierOn} onChange={(event) => setManualDehumidifierOn(event.target.checked)} className="accent-cyan-400" />
                    Manual dehumidifier
                  </label>
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-slate-300">PWM Exhaust Fan</span>
                  <span className="text-cyan-400 font-bold">{effectiveFanEffort.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-[#0a0f16] h-2.5 rounded-full overflow-hidden border border-[#1b2636]">
                  <div
                    className="bg-gradient-to-r from-cyan-500 to-blue-400 h-full rounded-full transition-all duration-300"
                    style={{ width: `${effectiveFanEffort}%` }}
                  ></div>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-slate-400">Ceramic Heating Element</span>
                  <span className="text-slate-500 font-bold">0% (OFF)</span>
                </div>
                <div className="w-full bg-[#0a0f16] h-2.5 rounded-full overflow-hidden border border-[#1b2636]">
                  <div className="bg-slate-700 h-full w-0"></div>
                </div>
              </div>

              <div className="pt-2 border-t border-[#1a2535] flex items-center justify-between text-xs font-mono">
                <span className="flex items-center gap-1.5 text-slate-300">
                  <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                  Desiccant Dehumidifier
                </span>
                <span className={`px-2.5 py-0.5 rounded border text-[11px] font-bold ${
                  effectiveDehumidifierOn
                    ? 'bg-amber-500/10 border-amber-500/40 text-amber-300' 
                    : 'bg-slate-800 border-slate-700 text-slate-500'
                }`}>
                  {effectiveDehumidifierOn ? 'LATCHED [ON]' : 'STANDBY [OFF]'}
                </span>
              </div>
            </div>

            <div className="lg:col-span-7 bg-[#121922] border border-[#222e3f] rounded-xl p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-bold text-white text-base">Closed-Loop Trajectory</h3>
                  <span className={`text-xs font-mono ${simulationRunning ? 'text-emerald-300' : 'text-slate-400'}`}>{simulationRunning ? 'SIMULATION RUNNING' : 'MODEL READY'}</span>
                </div>
                <p className="text-xs text-slate-400">
                  Simulated room temperature · target {temperatureSetpoint.toFixed(1)}°C · no physical equipment connected
                </p>
              </div>

              <div className="relative my-3 bg-[#090f16] rounded-lg border border-[#1d2939] p-4 h-36 flex items-center justify-center">
                <svg className="w-full h-full" viewBox="0 0 500 120">
                  <defs>
                    <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00e5ff" stopOpacity="0.2" />
                      <stop offset="100%" stopColor="#00e5ff" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  <line x1="20" y1={setpointY} x2="480" y2={setpointY} stroke="#00e5ff" strokeDasharray="3 3" strokeWidth="1" />
                  <text x="350" y={setpointY - 5} fill="#00e5ff" fontSize="10" fontFamily="monospace">
                    {temperatureSetpoint.toFixed(1)}°C Target
                  </text>
                  <polyline points={trajectoryPoints} fill="none" stroke="#00e5ff" strokeWidth="2.5" />
                  <circle cx={trajectoryCurrentX} cy={trajectoryCurrentY} r="4" fill="#38bdf8" />
                </svg>

                <div className="absolute bottom-1.5 left-6 right-6 flex justify-between text-[10px] font-mono text-slate-500">
                  <span>START</span>
                  <span>SIMULATED TEMPERATURE</span>
                  <span>NOW</span>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs font-mono text-slate-500 pt-2 border-t border-[#1b2737]">
                <span>Status: {simulationRunning ? 'Simulation running' : 'Simulation stopped'}</span>
                <span>Current: {temperature.toFixed(1)}°C · Setpoint: {temperatureSetpoint.toFixed(1)}°C</span>
              </div>
            </div>
          </div>
        </main>
      ) : (
        renderSecondaryPanel()
      )}

      <footer className="mt-8 border-t border-[#1d2737] bg-[#090f16] px-6 py-4 text-xs font-mono text-slate-500 flex flex-col md:flex-row items-center justify-between gap-2">
        <div>Engine: Mamdani Min-Max Centroid Inference • Inputs: [10°C - 40°C] / [10% - 100% RH]</div>
        <div>© 2025 Precision HVAC Automation Core</div>
      </footer>
    </div>
  );
}