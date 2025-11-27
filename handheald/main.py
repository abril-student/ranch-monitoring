# lora_rx_c3_soft.py — ESP32-C3 Super Mini + RA-02 (SX1278)
from machine import SoftSPI, Pin
import time, json
import gc
import network, socket, _thread
from lora_sx127x import (
    SX127x,
    REG_MODEM_CONFIG_1, REG_MODEM_CONFIG_2, REG_MODEM_CONFIG_3,
    REG_FRF_MSB, REG_FRF_MID, REG_FRF_LSB,
    REG_DIO_MAPPING_1,
    REG_IRQ_FLAGS, IRQ_RX_DONE_MASK, IRQ_VALID_HEADER,
    REG_FIFO_RX_CURRENT_ADDR, REG_FIFO_ADDR_PTR, REG_RX_NB_BYTES, REG_FIFO,
    REG_PKT_SNR_VALUE, REG_PKT_RSSI_VALUE
)


# ===== Pines ESP32-C3 Super Mini =====
PIN_SCK   = 4
PIN_MOSI  = 6
PIN_MISO  = 5
PIN_CS    = 7
PIN_DIO0  = 3
PIN_RST   = 2

# ===== SoftSPI =====
spi = SoftSPI(baudrate=1_000_000, polarity=0, phase=0,
              sck=Pin(PIN_SCK), mosi=Pin(PIN_MOSI), miso=Pin(PIN_MISO))

# ===== Radio LoRa =====
lora = SX127x(
    spi=spi, cs=PIN_CS, reset=PIN_RST, dio0=PIN_DIO0,
    freq_mhz=433.0,
    bw=7,            # 125 kHz
    cr=1,            # 4/5
    sf=12,           # SF12
    power=17
)

# DIO0 = RxDone
lora._write(REG_DIO_MAPPING_1, 0x00)

def decode_bw(bw_idx):
    return {0:"7.8",1:"10.4",2:"15.6",3:"20.8",4:"31.25",5:"41.7",6:"62.5",7:"125",8:"250",9:"500"}.get(bw_idx,"?")
def decode_cr(cr_bits):
    return {1:"4/5",2:"4/6",3:"4/7",4:"4/8"}.get(cr_bits,"?")

# ---- Print config en el chip ----
mc1 = lora._read(REG_MODEM_CONFIG_1)
mc2 = lora._read(REG_MODEM_CONFIG_2)
mc3 = lora._read(REG_MODEM_CONFIG_3)
frf = (lora._read(REG_FRF_MSB)<<16) | (lora._read(REG_FRF_MID)<<8) | lora._read(REG_FRF_LSB)
dio = lora._read(REG_DIO_MAPPING_1)
bw_idx = (mc1>>4)&0x0F
cr_bits = (mc1>>1)&0x07
sf_val  = (mc2>>4)&0x0F
crc_on  = bool(mc2 & 0x04)
ldo_on  = bool(mc3 & 0x08)
freq_mhz_eff = frf * 61.03515625 / 1e6

print("=== LoRa RX C3 listo (SoftSPI, RA-02) ===")
print("Freq  : {:.6f} MHz".format(freq_mhz_eff))
print("SF    : {}".format(sf_val))
print("BW    : {} kHz (idx={})".format(decode_bw(bw_idx), bw_idx))
print("CR    : {}".format(decode_cr(cr_bits)))
print("CRC   : {}".format("ON" if crc_on else "OFF"))
print("LDO   : {}".format("ON" if ldo_on else "OFF"))
print("DIO0  : mapeado a RxDone (REG_DIO_MAPPING_1=0x{:02X})".format(dio))
print("Esperando paquetes...")


# ===== Configuración Wi-Fi Access Point =====
def crear_wifi():    
    ap = network.WLAN(network.AP_IF)
    ap.active(True)
    time.sleep(1)
    ap.config(
        essid="Rancho-Monitoring",
        password="12345678",
        authmode=network.AUTH_WPA_WPA2_PSK,
        channel=6
    )
    print("\nPunto de acceso activo")
    print("SSID:", ap.config('essid'))
    print("IP:", ap.ifconfig()[0])

# =========================================================
#                  ACCESS POINT Y WEB SERVER
# =========================================================

last_payload = {} 
def read_packet():
    flags = lora._read(REG_IRQ_FLAGS)
    if not (flags & IRQ_RX_DONE_MASK):
        return None, None, None

    if flags & 0x20:
        lora._write(REG_IRQ_FLAGS, 0x20 | IRQ_VALID_HEADER | IRQ_RX_DONE_MASK)
        return None, None, None

    fifo_addr = lora._read(REG_FIFO_RX_CURRENT_ADDR)
    lora._write(REG_FIFO_ADDR_PTR, fifo_addr)
    n = lora._read(REG_RX_NB_BYTES)
    data = bytearray()
    for _ in range(n):
        data.append(lora._read(REG_FIFO))

    snr_reg = lora._read(REG_PKT_SNR_VALUE)
    if snr_reg > 127: snr_reg -= 256
    snr_db = snr_reg / 4.0
    rssi_dbm = -164 + lora._read(REG_PKT_RSSI_VALUE)

    lora._write(REG_IRQ_FLAGS, IRQ_RX_DONE_MASK | IRQ_VALID_HEADER)
    return bytes(data), rssi_dbm, snr_db


crear_wifi()

def web_init():
    global ws
    print("\n[WEB] Iniciando servidor web...")

    addr = socket.getaddrinfo("0.0.0.0", 80)[0][-1]
    ws = socket.socket()
    ws.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ws.bind(addr)
    ws.listen(3)
    ws.settimeout(0)
    print("[WEB] Servidor iniciado en puerto 80")


def servir_archivo(path):
    try:
        if path == "/" or path == "":
            full = "/www/index.html"
        else:
            full = "/www" + path

        print("[WEB] Abriendo:", full)
        with open(full, "rb") as f:
            return f.read()
    except OSError:
        print("[WEB] Archivo NO encontrado:", path)
        return None



def handle_http():
    try:
        cl, addr = ws.accept()
    except:
        return

    print("\n[HTTP] Cliente conectado:", addr)

    try:
        req = cl.recv(1024).decode()
    except:
        cl.close()
        return

    print("[HTTP] RAW request:")
    print(req)

    try:
        path = req.split(" ")[1]
    except:
        cl.close()
        return

    if "?" in path:
        path = path.split("?", 1)[0]

    print("[HTTP] Path:", path)

    if path in ("/data.json", "/data"):
        try:
            f = open("data.json", "rb")
            cl.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n")
            try:
                while True:
                    chunk = f.read(512)
                    if not chunk:
                        break
                    cl.write(chunk)
            except OSError as e:
                print("[HTTP] Error enviando data.json:", e)
            f.close()
        except OSError:
            cl.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n[]")
        try:
            cl.close()
        except:
            pass
        return

    if path == "/" or path == "":
        fs_path = "/www/index.html"
    else:
        fs_path = "/www" + path

    if path.endswith(".css"):
        mime = "text/css"
    elif path.endswith(".js"):
        mime = "application/javascript"
    elif path.endswith(".png"):
        mime = "image/png"
    elif path.endswith(".jpg") or path.endswith(".jpeg"):
        mime = "image/jpeg"
    else:
        mime = "text/html"

    try:
        f = open(fs_path, "rb")
        cl.write("HTTP/1.1 200 OK\r\nContent-Type: " + mime + "\r\nConnection: close\r\n\r\n")
        try:
            while True:
                chunk = f.read(512)
                if not chunk:
                    break
                cl.write(chunk)
        except OSError as e:
            print("[HTTP] Error enviando", path, ":", e)
        f.close()
    except OSError:
        cl.write("HTTP/1.1 404 NOT FOUND\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n404 No encontrado")

    try:
        cl.close()
    except:
        pass


web_init()


while True:
    try:
        handle_http()
    except OSError as e:
        print("[HTTP] Error en handle_http:", e)

    pkt, rssi, snr = read_packet()
    if pkt is not None:
        try:
            obj = json.loads(pkt.decode('utf-8'))
            lat = obj.get('lat'); lon = obj.get('lon')
            sats = obj.get('sats'); hdop = obj.get('hdop')
            alt  = obj.get('alt');  spd  = obj.get('spd_kn');
            crs = obj.get('crs'); date = obj.get('date')
            gps_time = obj.get('time'); battery = obj.get('bat_v');
            id_cow = obj.get('id')
            
            text = "GPS lat={:.6f} lon={:.6f} alt={}m sats={} hdop={} spd_kn={} crs={} | {}".format(
                lat if lat is not None else 0.0,
                lon if lon is not None else 0.0,
                "NA" if alt is None else "{:.1f}".format(alt),
                "NA" if sats is None else sats,
                "NA" if hdop is None else "{:.1f}".format(hdop),
                "NA" if spd is None else "{:.1f}".format(spd),
                "NA" if crs is None else "{:.1f}".format(crs),
                link
            )
        except Exception:
            try:
                text = pkt.decode('utf-8')
            except:
                text = str(pkt)
        print("[RX] RSSI={:.1f} dBm SNR={:.1f} dB -> {}".format(rssi, snr, text))

        try:
            payload = json.loads(text)
            id_       = payload.get("id")
            lat       = payload.get("lat")
            lon       = payload.get("lon")
            alt       = payload.get("alt")
            sats      = payload.get("sats")
            hdop      = payload.get("hdop")
            spd_kn    = payload.get("spd_kn")
            crs       = payload.get("crs")
            date      = payload.get("date")
            gps_time  = payload.get("gps_time")
            bat_v     = payload.get("bat_v")

            print("Payload OK -> ID:", id_, "Lat:", lat, "Lon:", lon)

            record = {
                "id": id_,
                "lat": lat,
                "lon": lon,
                "alt": alt,
                "sats": sats,
                "hdop": hdop,
                "spd_kn": spd_kn,
                "crs": crs,
                "date": date,
                "gps_time": gps_time,
                "bat_v": bat_v,
                "timestamp_local": time.time()
            }
            with open("data.json", "a") as f:
                f.write(json.dumps(record) + "\n")

            print("[OK] Registro guardado en data.json")

        except Exception as e:
            print("[ERROR] Payload no es JSON válido:", e)

     
        
        pass
    else:
        time.sleep_ms(20)
    
    gc.collect()