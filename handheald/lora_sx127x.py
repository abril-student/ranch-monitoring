# lora_sx127x.py – Driver LoRa SX1278/SX1276 para MicroPython ESP32
from machine import SPI, Pin
import time

REG_FIFO                = 0x00
REG_OP_MODE             = 0x01
REG_FRF_MSB             = 0x06
REG_FRF_MID             = 0x07
REG_FRF_LSB             = 0x08
REG_PA_CONFIG           = 0x09
REG_OCP                 = 0x0B
REG_LNA                 = 0x0C
REG_FIFO_ADDR_PTR       = 0x0D
REG_FIFO_TX_BASE_ADDR   = 0x0E
REG_FIFO_RX_BASE_ADDR   = 0x0F
REG_FIFO_RX_CURRENT_ADDR= 0x10
REG_IRQ_FLAGS           = 0x12
REG_RX_NB_BYTES         = 0x13
REG_PKT_SNR_VALUE       = 0x19
REG_PKT_RSSI_VALUE      = 0x1A
REG_MODEM_CONFIG_1      = 0x1D
REG_MODEM_CONFIG_2      = 0x1E
REG_SYMB_TIMEOUT_LSB    = 0x1F
REG_PREAMBLE_MSB        = 0x20
REG_PREAMBLE_LSB        = 0x21
REG_PAYLOAD_LENGTH      = 0x22
REG_MODEM_CONFIG_3      = 0x26
REG_DIO_MAPPING_1       = 0x40
REG_VERSION             = 0x42
REG_PA_DAC              = 0x4D

MODE_LONG_RANGE_MODE    = 0x80
MODE_SLEEP              = 0x00
MODE_STDBY              = 0x01
MODE_TX                 = 0x03
MODE_RX_CONTINUOUS      = 0x05

IRQ_TX_DONE_MASK        = 0x08
IRQ_RX_DONE_MASK        = 0x40
IRQ_VALID_HEADER        = 0x10

PA_BOOST                = 0x80

class SX127x:
    def __init__(self, spi, cs, reset, dio0,
                 freq_mhz=433.0, bw=7, cr=1, sf=12, power=17):
        self.spi = spi
        self.cs = Pin(cs, Pin.OUT, value=1)
        self.reset = None if (reset is None) else Pin(reset, Pin.OUT, value=1)
        self.dio0 = Pin(dio0, Pin.IN)
        self.payload_max = 255

        self._reset()
        v = self._read(REG_VERSION)
        if v == 0x00 or v == 0xFF:
            raise RuntimeError("SX127x not responding. Check pins / power / ant.")

        self._write(REG_OP_MODE, MODE_SLEEP | MODE_LONG_RANGE_MODE)
        time.sleep_ms(10)
        self._write(REG_OP_MODE, MODE_STDBY | MODE_LONG_RANGE_MODE)

        self.set_frequency(freq_mhz)
        self.set_bw_cr_sf(bw=bw, cr=cr, sf=sf)
        self.set_power(power)

        self._write(REG_PREAMBLE_MSB, 0x00)
        self._write(REG_PREAMBLE_LSB, 0x08)
        self._write(REG_FIFO_TX_BASE_ADDR, 0x00)
        self._write(REG_FIFO_RX_BASE_ADDR, 0x00)

        self._write(REG_LNA, 0x23)
        self._write(REG_OCP, 0x20 | 0x0B)

        self._write(REG_DIO_MAPPING_1, 0x40)
        self.receive()

    def set_power(self, power):
        if power > 20: power = 20
        if power < 2: power = 2
        self._write(REG_PA_CONFIG, PA_BOOST | (power - 2))
        self._write(REG_PA_DAC, 0x87 if power > 17 else 0x84)

    def set_frequency(self, mhz):
        frf = int((mhz * 1000000.0) / 61.03515625)
        self._write(REG_FRF_MSB, (frf >> 16) & 0xFF)
        self._write(REG_FRF_MID, (frf >> 8) & 0xFF)
        self._write(REG_FRF_LSB, frf & 0xFF)

    def set_bw_cr_sf(self, bw=7, cr=1, sf=12):
        bw = max(0, min(9, bw))
        cr = max(1, min(4, cr))
        sf = max(6, min(12, sf))

        self._write(REG_MODEM_CONFIG_1, (bw << 4) | (cr << 1))
        self._write(REG_MODEM_CONFIG_2, ((sf << 4) & 0xF0) | 0x04)
        ldo = 0x08 if (sf >= 11 and bw <= 7) else 0x00
        self._write(REG_MODEM_CONFIG_3, ldo | 0x04)
        self._write(REG_SYMB_TIMEOUT_LSB, 0xFF)

    def sleep(self):
        self._write(REG_OP_MODE, MODE_SLEEP | MODE_LONG_RANGE_MODE)

    def standby(self):
        self._write(REG_OP_MODE, MODE_STDBY | MODE_LONG_RANGE_MODE)

    def receive(self):
        self._write(REG_IRQ_FLAGS, 0xFF)
        self._write(REG_FIFO_ADDR_PTR, self._read(REG_FIFO_RX_BASE_ADDR))
        self._write(REG_OP_MODE, MODE_RX_CONTINUOUS | MODE_LONG_RANGE_MODE)

    def send(self, data, timeout_ms=5000):
        if len(data) > self.payload_max:
            data = data[:self.payload_max]

        self.standby()
        self._write(REG_FIFO_ADDR_PTR, self._read(REG_FIFO_TX_BASE_ADDR))

        for b in data:
            self._write(REG_FIFO, b)

        self._write(REG_PAYLOAD_LENGTH, len(data))
        self._write(REG_IRQ_FLAGS, 0xFF)
        self._write(REG_OP_MODE, MODE_TX | MODE_LONG_RANGE_MODE)

        t0 = time.ticks_ms()
        while True:
            flags = self._read(REG_IRQ_FLAGS)
            if flags & IRQ_TX_DONE_MASK:
                self._write(REG_IRQ_FLAGS, IRQ_TX_DONE_MASK)
                break
            if time.ticks_diff(time.ticks_ms(), t0) > timeout_ms:
                raise RuntimeError("TX timeout")
            time.sleep_ms(1)

        self.receive()

    def any(self):
        return self.dio0.value() == 1

    def recv(self):
        if not self.any():
            return None, None, None

        irq = self._read(REG_IRQ_FLAGS)
        if not (irq & IRQ_RX_DONE_MASK):
            return None, None, None

        fifo_addr = self._read(REG_FIFO_RX_CURRENT_ADDR)
        self._write(REG_FIFO_ADDR_PTR, fifo_addr)
        n = self._read(REG_RX_NB_BYTES)
        data = bytearray()
        for _ in range(n):
            data.append(self._read(REG_FIFO))

        self._write(REG_IRQ_FLAGS, IRQ_RX_DONE_MASK | IRQ_VALID_HEADER)

        snr = self._read(REG_PKT_SNR_VALUE)
        if snr > 127: snr -= 256
        snr /= 4.0

        rssi = self._read(REG_PKT_RSSI_VALUE)
        rssi = -164 + rssi

        return bytes(data), rssi, snr

    def _reset(self):
        if self.reset is None:
            time.sleep_ms(10)
            return
        self.reset.value(0)
        time.sleep_ms(10)
        self.reset.value(1)
        time.sleep_ms(10)

    def _read(self, addr):
        self.cs.value(0)
        self.spi.write(bytearray([addr & 0x7F]))
        val = self.spi.read(1)[0]
        self.cs.value(1)
        return val

    def _write(self, addr, val):
        self.cs.value(0)
        self.spi.write(bytearray([addr | 0x80, val & 0xFF]))
        self.cs.value(1)

