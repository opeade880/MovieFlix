import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
    collection,
    getDocs,
    getFirestore
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import {
    getAuth,
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const accountPage = document.querySelector(".account-page");
const accountLoading = document.getElementById("accountLoading");
const accountSignedOut = document.getElementById("accountSignedOut");
const accountSignedIn = document.getElementById("accountSignedIn");
const accountEmail = document.getElementById("accountEmail");
const accountStatus = document.getElementById("accountStatus");
const watchlistCount = document.getElementById("watchlistCount");
const watchlistCountStatus = document.getElementById("watchlistCountStatus");
const accountError = document.getElementById("accountError");
const accountLogout = document.getElementById("accountLogout");

function setAccountState(state) {

    accountPage?.classList.toggle("is-loading", state === "loading");
    accountLoading.hidden = state !== "loading";
    accountSignedOut.hidden = state !== "signed-out";
    accountSignedIn.hidden = state !== "signed-in";

}

function getUniqueWatchlistCount(snapshot) {

    const movieIds = new Set();

    snapshot.docs.forEach(movieDocument => {
        const movie = movieDocument.data();
        movieIds.add(String(movie.id ?? movieDocument.id));
    });

    return movieIds.size;

}

function showAccountError(message) {

    accountError.hidden = false;
    accountError.textContent = message;
    watchlistCountStatus.textContent = "Watchlist count unavailable";

}

async function loadAccount(user) {

    setAccountState("signed-in");
    accountEmail.textContent = user.email || "Email unavailable";
    accountStatus.textContent = "Signed in with Firebase Authentication";
    watchlistCount.textContent = "...";
    watchlistCountStatus.textContent = "Loading saved movies...";
    accountError.hidden = true;

    try {
        const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
        const firestore = getFirestore(app);
        const snapshot = await getDocs(collection(firestore, "users", user.uid, "watchlist"));
        const count = getUniqueWatchlistCount(snapshot);

        watchlistCount.textContent = String(count);
        watchlistCountStatus.textContent = count === 1
            ? "movie saved"
            : "movies saved";

        console.info("Account watchlist count loaded:", {
            uid: user.uid,
            count
        });
    } catch (error) {
        console.error("Error loading account watchlist count:", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            uid: user.uid,
            path: `users/${user.uid}/watchlist`,
            error
        });
        watchlistCount.textContent = "-";
        showAccountError("We could not load your watchlist count. Please try again later.");
    }

}

function startAccountPage() {

    if (!accountPage || !accountLoading || !accountSignedOut || !accountSignedIn) {
        return;
    }

    if (!isFirebaseConfigured) {
        setAccountState("signed-out");
        accountStatus.textContent = "Firebase Authentication is not configured.";
        return;
    }

    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = getAuth(app);

    onAuthStateChanged(auth, user => {
        if (user) {
            loadAccount(user);
        } else {
            setAccountState("signed-out");
        }
    });

    accountLogout?.addEventListener("click", async () => {
        accountLogout.disabled = true;
        accountLogout.textContent = "Logging out...";

        try {
            await signOut(auth);
        } catch (error) {
            console.error("Error signing out from account page:", error);
            accountLogout.disabled = false;
            accountLogout.textContent = "Logout";
            showAccountError("We could not log you out. Please try again.");
        }
    });

}

startAccountPage();
