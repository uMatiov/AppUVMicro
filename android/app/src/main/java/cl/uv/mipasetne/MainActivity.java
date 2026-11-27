package cl.uv.mipasetne;

import android.content.ComponentName;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.cardemulation.CardEmulation;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private NfcAdapter nfcAdapter;
    private CardEmulation cardEmulation;
    private boolean modoLecturaTne = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        nfcAdapter = NfcAdapter.getDefaultAdapter(this);
        if (nfcAdapter != null) {
            try {
                cardEmulation = CardEmulation.getInstance(nfcAdapter);
            } catch (Exception ignored) {}
        }

        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().addJavascriptInterface(new NfcBridge(), "AndroidNfc");
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        aplicarModoNfc();
    }

    @Override
    public void onPause() {
        super.onPause();
        if (nfcAdapter != null) {
            try { nfcAdapter.disableReaderMode(this); } catch (Exception ignored) {}
        }
        if (cardEmulation != null) {
            try { cardEmulation.unsetPreferredService(this); } catch (Exception ignored) {}
        }
    }

    private void aplicarModoNfc() {
        if (nfcAdapter == null) return;
        if (modoLecturaTne) {
            if (cardEmulation != null) {
                try { cardEmulation.unsetPreferredService(this); } catch (Exception ignored) {}
            }
            int readerFlags = NfcAdapter.FLAG_READER_NFC_A
                    | NfcAdapter.FLAG_READER_NFC_B
                    | NfcAdapter.FLAG_READER_NFC_F
                    | NfcAdapter.FLAG_READER_NFC_V
                    | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK;
            nfcAdapter.enableReaderMode(this, this::enviarUidAlWebView, readerFlags, null);
        } else {
            // Modo pago sin contacto: apaga el lector y deja libre el servicio HCE para el RC522
            try { nfcAdapter.disableReaderMode(this); } catch (Exception ignored) {}
            if (cardEmulation != null) {
                try {
                    cardEmulation.setPreferredService(this, new ComponentName(this, TneHceService.class));
                } catch (Exception ignored) {}
            }
        }
    }

    private void enviarUidAlWebView(Tag tag) {
        if (tag == null) return;
        byte[] id = tag.getId();
        if (id == null || id.length == 0) return;
        StringBuilder hex = new StringBuilder();
        for (byte b : id) {
            hex.append(String.format("%02X", b));
        }
        final String uidHex = hex.toString();
        runOnUiThread(() -> {
            if (this.bridge != null && this.bridge.getWebView() != null) {
                this.bridge.getWebView().evaluateJavascript(
                    "if (window.onNativeNfcScanned) { window.onNativeNfcScanned('" + uidHex + "'); }",
                    null
                );
            }
        });
    }

    public class NfcBridge {
        @JavascriptInterface
        public void setModoLecturaTne(final boolean activar) {
            runOnUiThread(() -> {
                modoLecturaTne = activar;
                aplicarModoNfc();
            });
        }

        @JavascriptInterface
        public boolean tieneNfcActivo() {
            return nfcAdapter != null && nfcAdapter.isEnabled();
        }
    }
}