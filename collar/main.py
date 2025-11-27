# lora_gps_tx_rp2040.py — RP2040-Zero + GPS NEO-6M + LoRa RA-02 (SX1278)

from machine import SPI, Pin, UART
import time
from lora_sx127x import SX127x

# ------------------ Config debug & tiempos ------------------
debug = True  # True = más mensajes los primeros 3 min, False = siempre cada sendingInterval
sendingInterval = 1 * 60 * 1000  # intervalo normal en ms (1 minutos)

DEBUG_FAST_MS = 2000              # intervalo rápido (2 s) cuando debug=True
DEBUG_DURATION_MS = 3 * 60 * 1000 # duración del modo rápido: 3 minutos

# ------------------ Pins (SPI1 + UART1) ------------------
PIN_SCK  = 10
PIN_MOSI = 11
PIN_MISO = 12
PIN_CS   = 13
PIN_RST  = 14
PIN_DIO0 = 15

GPS_TX = 4
GPS_RX = 5

# ------------------ LoRa (SPI1) ------------------
spi = SPI(1, baudrate=8_000_000, polarity=0, phase=0,
          sck=Pin(PIN_SCK), mosi=Pin(PIN_MOSI), miso=Pin(PIN_MISO))

lora = SX127x(
    spi=spi,
    cs=PIN_CS, reset=PIN_RST, dio0=PIN_DIO0,
    freq_mhz=433.0,
    bw=7,           # 125 kHz
    cr=1,           # 4/5
    sf=12,          # SF12
    power=14
)

# ------------------ GPS (UART1 @ 9600) ------------------
gps = UART(1, baudrate=9600, bits=8, parity=None, stop=1,
           tx=Pin(GPS_TX), rx=Pin(GPS_RX), timeout=1000)

# ------------------ Helpers ------------------
def _clean_field(s):
    if not s:
        return ""
    s = s.split("*", 1)[0]
    return s.strip().replace("\x00", "")

def _safe_int(s, default=0):
    try:
        s = _clean_field(s)
        if s == "":
            return default
        return int(s)
    except:
        return default

def _safe_float(s, default=0.0):
    try:
        s = _clean_field(s)
        if s == "":
            return default
        return float(s)
    except:
        return default

def _dm_to_deg(dm, hemi):
    try:
        dm = _clean_field(dm)
        if not dm or "." not in dm:
            return None
        head, frac = dm.split(".")
        mins = float(head[-2:] + "." + frac)
        deg = float(head[:-2]) if head[:-2] else 0.0
        out = deg + mins / 60.0
        if hemi in ("S", "W"):
            out = -out
        return out
    except:
        return None

def parse_nmea(line):
    if not line:
        return None
    try:
        s = line.decode("ascii", "ignore")
    except:
        s = str(line)
    s = s.strip().replace("\x00", "")
    if not s.startswith("$") or "*" not in s:
        return None
    s = s.split("*", 1)[0]
    p = s.split(",")
    tag = p[0][3:] if len(p[0]) >= 6 else p[0]

    # RMC
    if tag in ("RMC", "GNRMC"):
        if len(p) < 10:
            return None
        status = _clean_field(p[2])
        if status != "A":
            return {"valid": False}
        return {
            "valid": True,
            "lat": _dm_to_deg(p[3], _clean_field(p[4])),
            "lon": _dm_to_deg(p[5], _clean_field(p[6])),
            "spd_kn": _safe_float(p[7], 0.0),
            "crs": _safe_float(p[8], 0.0),
            "date": _clean_field(p[9]),
            "time": _clean_field(p[1]),
        }

    # GGA
    if tag in ("GGA", "GNGGA"):
        if len(p) < 10:
            return None
        return {
            "gga": True,
            "fix":  _safe_int(p[6], 0),
            "lat":  _dm_to_deg(p[2], _clean_field(p[3])),
            "lon":  _dm_to_deg(p[4], _clean_field(p[5])),
            "sats": _safe_int(p[7], 0),
            "hdop": _safe_float(p[8], 99.0),
            "alt":  _safe_float(p[9], 0.0),
        }

    return None

# ------------------ Payload reducido ------------------
def build_payload(rmc, gga):
    if not rmc or not rmc.get("valid"):
        return None

    lat, lon = rmc["lat"], rmc["lon"]
    if lat is None or lon is None:
        return None

    sats = gga.get("sats") if gga else None

    return '{{"lat":{:.6f},"lon":{:.6f},"sats":{},"spd_kn":{},"crs":{},"gps_time":"{}","bat_v":62,"id":1}}'.format(
        lat,
        lon,
        "null" if sats is None else sats,
        "{:.1f}".format(rmc.get("spd_kn", 0.0)),
        "{:.1f}".format(rmc.get("crs", 0.0)),
        rmc.get("time", "")
    )

# ------------------ Main ------------------
print("🚀 LoRa GPS TX (RP2040-Zero + RA-02) iniciado")
print("⏳ Esperando FIX GPS... (antena hacia el cielo)")

last_rmc = None
last_gga = None
have_fix = False

start_ms = time.ticks_ms()
t0 = start_ms
seq = 0

while True:
    now = time.ticks_ms()
    uptime_ms = time.ticks_diff(now, start_ms)

    # determinar periodo actual según debug/tiempo
    if debug and uptime_ms < DEBUG_DURATION_MS:
        tx_period = DEBUG_FAST_MS
    else:
        tx_period = sendingInterval

    if gps.any():
        raw = gps.readline()
        if raw:
            d = parse_nmea(raw)
            if d:
                if d.get("gga"):
                    last_gga = d
                    if d.get("fix", 0) >= 1 and not have_fix:
                        have_fix = True
                        print("✅ FIX GPS detectado — TX debug={}".format(debug))
                elif "valid" in d:
                    last_rmc = d

    if time.ticks_diff(now, t0) >= tx_period:
        t0 = now
        pl = build_payload(last_rmc, last_gga)
        if pl:
            try:
                lora.send(pl.encode())
                print("[TX {:06d}] {}".format(seq, pl))
                seq += 1
            except Exception as e:
                print("⚠️ Error TX:", e)
        else:
            print("[TX] GPS sin fix — esperando...")

    time.sleep_ms(5)
