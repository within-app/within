// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
// "within" ist der App-Name und bleibt in allen Sprachen unübersetzt.
const de = {
  dialogLabel: "within ist gesperrt",
  unlock: "Entsperren",
  // PIN-Vault (Sicherheitskonzept Offline-Daten, P1)
  setupTitle: "App-PIN einrichten",
  setupIntro:
    "Die PIN verschlüsselt deine Einträge und Fotos auf diesem Gerät. Ohne sie sind die Offline-Daten nicht lesbar — auch nicht für jemanden mit deinem entsperrten Handy.",
  setupHint: "Mindestens 6 Zeichen. Eine längere Passphrase schützt besser als Ziffern.",
  pinLabel: "App-PIN",
  pinConfirmLabel: "PIN wiederholen",
  pinMismatch: "Die Eingaben stimmen nicht überein.",
  pinTooShort: (min: number) => `Mindestens ${min} Zeichen.`,
  setupSubmit: "Einrichten & verschlüsseln",
  settingUp: "Verschlüssele…",
  enterPin: "PIN eingeben, um zu entsperren",
  wrongPin: "Falsche PIN.",
  unlocking: "Entsperre…",
  forgotPin: "PIN vergessen?",
  resetWarning:
    "Ohne PIN können die lokalen Daten nicht entschlüsselt werden. Zurücksetzen löscht alle Offline-Daten auf diesem Gerät — noch nicht gesyncte Änderungen gehen verloren. Der Server bleibt unberührt; nach der Anmeldung lädt die App alles neu.",
  resetConfirm: "Lokale Daten löschen & neu anmelden",
  resetCancel: "Abbrechen",
  resetting: "Setze zurück…",
  // Vault P2: WebCrypto gibt es nur in Secure Contexts — klarer Hinweis
  // statt kryptischem Fehler beim PIN-Setup über plain HTTP.
  insecureTitle: "HTTPS erforderlich",
  insecureBody:
    "within wurde über unverschlüsseltes HTTP geöffnet. Die Verschlüsselung der Offline-Daten braucht einen sicheren Kontext (WebCrypto). Bitte öffne within über seine HTTPS-Adresse.",
}

type SectionMessages = typeof de

const en: SectionMessages = {
  dialogLabel: "within is locked",
  unlock: "Unlock",
  setupTitle: "Set up app PIN",
  setupIntro:
    "The PIN encrypts your entries and photos on this device. Without it the offline data is unreadable — even for someone holding your unlocked phone.",
  setupHint: "At least 6 characters. A longer passphrase protects better than digits.",
  pinLabel: "App PIN",
  pinConfirmLabel: "Repeat PIN",
  pinMismatch: "The entries do not match.",
  pinTooShort: (min: number) => `At least ${min} characters.`,
  setupSubmit: "Set up & encrypt",
  settingUp: "Encrypting…",
  enterPin: "Enter PIN to unlock",
  wrongPin: "Wrong PIN.",
  unlocking: "Unlocking…",
  forgotPin: "Forgot PIN?",
  resetWarning:
    "Without the PIN the local data cannot be decrypted. Resetting deletes all offline data on this device — unsynced changes are lost. The server is untouched; after logging in the app reloads everything.",
  resetConfirm: "Delete local data & log in again",
  resetCancel: "Cancel",
  resetting: "Resetting…",
  insecureTitle: "HTTPS required",
  insecureBody:
    "within was opened over unencrypted HTTP. Encrypting the offline data requires a secure context (WebCrypto). Please open within via its HTTPS address.",
}

const fr: SectionMessages = {
  dialogLabel: "within est verrouillée",
  unlock: "Déverrouiller",
  setupTitle: "Configurer le code de l'app",
  setupIntro:
    "Le code chiffre tes entrées et photos sur cet appareil. Sans lui, les données hors ligne sont illisibles — même pour quelqu'un qui tient ton téléphone déverrouillé.",
  setupHint: "Au moins 6 caractères. Une phrase secrète plus longue protège mieux que des chiffres.",
  pinLabel: "Code de l'app",
  pinConfirmLabel: "Répéter le code",
  pinMismatch: "Les saisies ne correspondent pas.",
  pinTooShort: (min: number) => `Au moins ${min} caractères.`,
  setupSubmit: "Configurer et chiffrer",
  settingUp: "Chiffrement…",
  enterPin: "Saisis le code pour déverrouiller",
  wrongPin: "Code incorrect.",
  unlocking: "Déverrouillage…",
  forgotPin: "Code oublié ?",
  resetWarning:
    "Sans le code, les données locales ne peuvent pas être déchiffrées. La réinitialisation supprime toutes les données hors ligne de cet appareil — les modifications non synchronisées sont perdues. Le serveur reste intact ; après la connexion, l'app recharge tout.",
  resetConfirm: "Supprimer les données locales et se reconnecter",
  resetCancel: "Annuler",
  resetting: "Réinitialisation…",
  insecureTitle: "HTTPS requis",
  insecureBody:
    "within a été ouverte via HTTP non chiffré. Le chiffrement des données hors ligne nécessite un contexte sécurisé (WebCrypto). Ouvre within via son adresse HTTPS.",
}

export const lockMessages = { de, en, fr }
