package cl.uv.mipasetne;

import android.nfc.cardemulation.HostApduService;
import android.os.Bundle;
import java.nio.charset.StandardCharsets;

public class TneHceService extends HostApduService {
    @Override
    public byte[] processCommandApdu(byte[] commandApdu, Bundle extras) {
        byte[] ok = new byte[] { (byte) 0x90, (byte) 0x00 };
        byte[] payload = "TNE_OK".getBytes(StandardCharsets.UTF_8);
        byte[] respuesta = new byte[payload.length + ok.length];
        System.arraycopy(payload, 0, respuesta, 0, payload.length);
        System.arraycopy(ok, 0, respuesta, payload.length, ok.length);
        return respuesta;
    }

    @Override
    public void onDeactivated(int reason) {
    }
}