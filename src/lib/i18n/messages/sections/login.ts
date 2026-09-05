// Section dictionary — wird vom Integrator in den zentralen Messages-Baum verdrahtet.
const de = {
  tagline: "Dein privates, selbst-gehostetes Tagebuch",
  title: "Anmelden",
  description: "Gib dein Passwort ein, um fortzufahren.",
  passwordLabel: "Passwort",
  passwordPlaceholder: "Passwort eingeben",
  submit: "Anmelden",
  submitting: "Anmelden…",
  loginFailed: "Anmeldung fehlgeschlagen",
  networkError: "Netzwerkfehler — ist der Server erreichbar?",
  configError: {
    title: "Konfigurationsfehler",
    hashInstruction: "Es ist kein Login-Passwort konfiguriert. Trag dein Wunschpasswort ein:",
    hashCommand: `APP_PASSWORD=dein-passwort`,
    envPrefix: "in der Datei ",
    envSuffix: ", dann neu starten:",
  },
}

type SectionMessages = typeof de

const en: SectionMessages = {
  tagline: "Your private, self-hosted journal",
  title: "Sign in",
  description: "Enter your password to continue.",
  passwordLabel: "Password",
  passwordPlaceholder: "Enter password",
  submit: "Sign in",
  submitting: "Signing in…",
  loginFailed: "Sign-in failed",
  networkError: "Network error — is the server reachable?",
  configError: {
    title: "Configuration error",
    hashInstruction: "No login password is configured. Enter the password you want:",
    hashCommand: `APP_PASSWORD=your-password`,
    envPrefix: "in the file ",
    envSuffix: ", then restart:",
  },
}

const fr: SectionMessages = {
  tagline: "Ton journal privé, auto-hébergé",
  title: "Se connecter",
  description: "Saisis ton mot de passe pour continuer.",
  passwordLabel: "Mot de passe",
  passwordPlaceholder: "Saisis ton mot de passe",
  submit: "Se connecter",
  submitting: "Connexion…",
  loginFailed: "Échec de la connexion",
  networkError: "Erreur réseau — le serveur est-il joignable ?",
  configError: {
    title: "Erreur de configuration",
    hashInstruction: "Aucun mot de passe de connexion n'est configuré. Saisis le mot de passe souhaité :",
    hashCommand: `APP_PASSWORD=ton-mot-de-passe`,
    envPrefix: "dans le fichier ",
    envSuffix: ", puis redémarre :",
  },
}

export const loginMessages = { de, en, fr }
