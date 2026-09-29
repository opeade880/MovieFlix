import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
    browserLocalPersistence,
    createUserWithEmailAndPassword,
    getAuth,
    onAuthStateChanged,
    setPersistence,
    signInWithEmailAndPassword,
    signOut,
    updateProfile
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setFormMessage(messageElement, message, type = "") {

    if (!messageElement) {
        return;
    }

    messageElement.textContent = message;
    messageElement.className = `auth-message${type ? ` ${type}` : ""}`;

}

function setButtonLoading(button, isLoading) {

    if (!button) {
        return;
    }

    if (!button.dataset.defaultLabel) {
        button.dataset.defaultLabel = button.textContent;
    }

    button.disabled = isLoading;
    button.textContent = isLoading
        ? button.dataset.loadingLabel || "Please wait..."
        : button.dataset.defaultLabel;

}

function getSafeRedirect() {

    const redirect = new URLSearchParams(window.location.search).get("redirect");

    if (redirect === "watchlist.html") {
        return redirect;
    }

    if (/^movie\.html\?id=\d+$/.test(redirect || "")) {
        return redirect;
    }

    return "index.html";

}

function getAuthErrorMessage(error) {

    switch (error.code) {
        case "auth/email-already-in-use":
            return "An account already exists for this email address.";
        case "auth/invalid-email":
            return "Please enter a valid email address.";
        case "auth/weak-password":
            return "Use a stronger password with at least 6 characters.";
        case "auth/operation-not-allowed":
            return "Email and password sign-in is not enabled in Firebase Console.";
        case "auth/invalid-credential":
        case "auth/wrong-password":
        case "auth/user-not-found":
            return "Incorrect email or password.";
        case "auth/network-request-failed":
            return "We could not reach the authentication service. Check your connection and try again.";
        case "auth/too-many-requests":
            return "Too many attempts. Please wait a moment before trying again.";
        default:
            return "We could not complete that request. Please try again.";
    }

}

function validatePassword(password) {

    if (password.length < 8) {
        return "Password must be at least 8 characters long.";
    }

    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
        return "Password must include uppercase, lowercase, and a number.";
    }

    return "";

}

function renderAuthNavigation(user) {

    const authNavigation = document.getElementById("authNav");

    if (!authNavigation) {
        return;
    }

    authNavigation.innerHTML = "";

    if (!user) {
        const loginLink = document.createElement("a");
        const signupLink = document.createElement("a");

        loginLink.className = "auth-link";
        loginLink.href = "login.html";
        loginLink.textContent = "Login";

        signupLink.className = "auth-link auth-signup-link";
        signupLink.href = "register.html";
        signupLink.textContent = "Sign Up";

        authNavigation.append(loginLink, signupLink);
        return;
    }

    const userLabel = document.createElement("span");
    const logoutButton = document.createElement("button");
    const nameOrEmail = user.displayName || user.email || "MovieFlix user";

    userLabel.className = "auth-user-label";
    userLabel.textContent = user.displayName && user.email
        ? `${nameOrEmail} (${user.email})`
        : nameOrEmail;
    userLabel.title = user.email || "";

    logoutButton.className = "auth-link logout-button";
    logoutButton.type = "button";
    logoutButton.textContent = "Logout";

    logoutButton.addEventListener("click", async () => {

        setButtonLoading(logoutButton, true);

        try {
            await signOut(getAuth());
        } catch (error) {
            console.error("Error signing out:", error);
            setButtonLoading(logoutButton, false);
        }

    });

    authNavigation.append(userLabel, logoutButton);

}

function setupLoginForm(auth) {

    const loginForm = document.getElementById("loginForm");
    const emailInput = document.getElementById("loginEmail");
    const passwordInput = document.getElementById("loginPassword");
    const submitButton = document.getElementById("loginSubmit");
    const status = document.getElementById("loginStatus");

    if (!loginForm || !emailInput || !passwordInput || !submitButton || !status) {
        return;
    }

    loginForm.addEventListener("submit", async event => {

        event.preventDefault();

        const email = emailInput.value.trim();
        const password = passwordInput.value;

        if (!email || !password) {
            setFormMessage(status, "Enter your email address and password.", "is-error");
            return;
        }

        if (!EMAIL_PATTERN.test(email)) {
            setFormMessage(status, "Please enter a valid email address.", "is-error");
            return;
        }

        setFormMessage(status, "Signing you in...", "is-loading");
        setButtonLoading(submitButton, true);

        try {
            await signInWithEmailAndPassword(auth, email, password);
            window.location.href = getSafeRedirect();
        } catch (error) {
            console.error("Error signing in:", error);
            setFormMessage(status, getAuthErrorMessage(error), "is-error");
            setButtonLoading(submitButton, false);
        }

    });

}

function setupSignupForm(auth) {

    const signupForm = document.getElementById("signupForm");
    const nameInput = document.getElementById("signupName");
    const emailInput = document.getElementById("signupEmail");
    const passwordInput = document.getElementById("signupPassword");
    const confirmPasswordInput = document.getElementById("signupConfirmPassword");
    const submitButton = document.getElementById("signupSubmit");
    const status = document.getElementById("signupStatus");

    if (!signupForm || !nameInput || !emailInput || !passwordInput || !confirmPasswordInput || !submitButton || !status) {
        return;
    }

    signupForm.addEventListener("submit", async event => {

        event.preventDefault();

        const name = nameInput.value.trim();
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        const confirmPassword = confirmPasswordInput.value;
        const passwordError = validatePassword(password);

        if (!name || !email || !password || !confirmPassword) {
            setFormMessage(status, "Complete all fields to create your account.", "is-error");
            return;
        }

        if (name.length < 2) {
            setFormMessage(status, "Please enter your name.", "is-error");
            return;
        }

        if (!EMAIL_PATTERN.test(email)) {
            setFormMessage(status, "Please enter a valid email address.", "is-error");
            return;
        }

        if (passwordError) {
            setFormMessage(status, passwordError, "is-error");
            return;
        }

        if (password !== confirmPassword) {
            setFormMessage(status, "Passwords do not match.", "is-error");
            return;
        }

        setFormMessage(status, "Creating your account...", "is-loading");
        setButtonLoading(submitButton, true);

        try {
            const credential = await createUserWithEmailAndPassword(auth, email, password);

            console.info("Firebase account created:", {
                uid: credential.user.uid,
                email: credential.user.email
            });

            try {
                await updateProfile(credential.user, { displayName: name });
            } catch (error) {
                console.warn("Account created, but the display name could not be saved:", error);
            }

            window.location.href = getSafeRedirect();
        } catch (error) {
            console.error("Error creating account:", error);
            setFormMessage(status, getAuthErrorMessage(error), "is-error");
            setButtonLoading(submitButton, false);
        }

    });

}

function showConfigurationMessage() {

    document.querySelectorAll(".auth-message").forEach(message => {
        setFormMessage(
            message,
            "Authentication needs Firebase configuration. Add your public Web app config to firebase-config.js.",
            "is-error"
        );
    });

    document.querySelectorAll("[data-auth-submit]").forEach(button => {
        button.disabled = true;
    });

}

async function startAuthentication() {

    if (!isFirebaseConfigured) {
        console.error("Firebase Authentication is not configured. Check firebase-config.js.");
        renderAuthNavigation(null);
        showConfigurationMessage();
        return;
    }

    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = getAuth(app);

    console.info("Firebase Authentication initialized.", {
        projectId: firebaseConfig.projectId,
        authDomain: firebaseConfig.authDomain
    });

    try {
        await setPersistence(auth, browserLocalPersistence);
        console.info("Firebase Authentication persistence set to browserLocalPersistence.");
    } catch (error) {
        console.error("Error setting authentication persistence:", error);
    }

    onAuthStateChanged(auth, user => {

        console.info("Firebase Authentication state changed:", user
            ? { uid: user.uid, email: user.email }
            : "signed out");

        renderAuthNavigation(user);

        if (!user && document.body.dataset.requiresAuth === "true") {
            window.location.replace("login.html?redirect=watchlist.html");
        }

    });

    setupLoginForm(auth);
    setupSignupForm(auth);

}

startAuthentication().catch(error => {
    console.error("Error starting authentication:", error);
    showConfigurationMessage();
});
