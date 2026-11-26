package cl.uv.mipasetne;

import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Intent;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.cardemulation.CardEmulation;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private NfcAdapter nfcAdapter;
    private CardEmulation cardEmulation;
    private PendingIntent pendingIntent;
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

        Intent intent = new Intent(this, getClass()).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        pendingIntent = PendingIntent.getActivity(this, 0, intent, flags);

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
            try { nfcAdapter.disableForegroundDispatch(this); } catch (Exception ignored) {}
        }
        if (cardEmulation != null) {
            try { cardEmulation.unsetPreferredService(this); } catch (Exception ignored) {}
        }
    }

    private void aplicarModoNfc() {
        if (nfcAdapter == null) return;
        if (modoLecturaTne) {
            // Modo exclusivo para leer tarjetas TNE físicas (Mifare Classic sin NDEF)
            if (cardEmulation != null) {
                try { cardEmulation.unsetPreferredService(this); } catch (Exception ignored) {}
            }
            try { nfcAdapter.disableForegroundDispatch(this); } catch (Exception ignored) {}
            int readerFlags = NfcAdapter.FLAG_READER_NFC_A
                    | NfcAdapter.FLAG_READER_NFC_B
                    | NfcAdapter.FLAG_READER_NFC_F
                    | NfcAdapter.FLAG_READER_NFC_V
                    | NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK;
            nfcAdapter.enableReaderMode(this, this::enviarUidAlWebView, readerFlags, null);
        } else {
            // Modo pago sin contacto: apaga ReaderMode para activar emulación HCE ante el RC522
            try { nfcAdapter.disableReaderMode(this); } catch (Exception ignored) {}
            if (cardEmulation != null) {
                try {
                    cardEmulation.setPreferredService(this, new ComponentName(this, TneHceService.class));
                } catch (Exception ignored) {}
            }
            if (pendingIntent != null) {
                try { nfcAdapter.enableForegroundDispatch(this, pendingIntent, null, null); } catch (Exception ignored) {}
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

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent == null) return;
        String action = intent.getAction();
        if (NfcAdapter.ACTION_TAG_DISCOVERED.equals(action) ||
            NfcAdapter.ACTION_NDEF_DISCOVERED.equals(action) ||
            NfcAdapter.ACTION_TECH_DISCOVERED.equals(action)) {
            Tag tag = intent.getParcelableExtra(NfcAdapter.EXTRA_TAG);
            enviarUidAlWebView(tag);
        }
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