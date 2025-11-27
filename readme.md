# Ranch Monitoring

Video Demo: https://youtu.be/OcY-_pE_gZg

## Architecture

### Collar
- Microcontrolador: RP2040-Zero.
- Radio LoRa: RA-02 (SX1278) conectado por SPI1 (SCK=10, MOSI=11, MISO=12, CS=13, RST=14, DIO0=15).
- GPS: NEO-6M conectado por UART1 (TX=4, RX=5).
- Firmware en MicroPython (dentro de la carpeta collar).

#### Features:
- Lee sentencias NMEA (RMC y GGA) del GPS.
- Convierte lat/lon de formato grados-minutos a grados decimales.
- Verifica que haya fix válido.
- Construye un payload JSON enviado al handheald.

### Handheald
- Microcontrolador: ESP32 C3 Super Mini
- Radio LoRa: RA-02 (SX1278) configurado con los mismos parámetros (433 MHz, BW=7, SF=12, CR=4/5).
- Firmware en MicroPython (dentro de la carpeta handheal).

#### Features
- Escuchar continuamente por mensajes del collar.
- Recibir el JSON y parsearlo.
- Hostear la página web y actualizarla con los datos. 

### Página Web
Despliega el mapa con el punto del collar en movimiento, permite descargarlos datos, así como triggerea alarmas en caso de que el animal abandone la geocerca.


## Parámetros de comunicación

- Potencia de transmisión: aproximadamente 14 dBm, configurada sobre salida PA_BOOST del SX1278.
- Ancho de banda (BW): 125 kHz.
- Spreading Factor (SF): SF12 para maximizar alcance en campo rural.
- Coding Rate (CR):  ⅘.
- Intervalo de envio de mensajes: Cada 5 minutos.
- Tasa de datos: SF12 + BW 125 kHz, rango de centenas de bits por segundo.

