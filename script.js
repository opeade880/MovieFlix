import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    collection,
    collectionGroup,
    limit,
    query,
    setDoc,
    serverTimestamp,
    where
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import {
    getAuth,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const API_KEY = "c1e3cd3a10c373aa09839a68c5565d2a";

const API_URL = "https://api.themoviedb.org/3";
const IMAGE_URL = "https://image.tmdb.org/t/p/w500";
const INTERNET_ARCHIVE_URL = "https://archive.org";
const WATCHLIST_KEY = "movieflixWatchlist";
const DISCOVERY_DEFAULT_SORT = "popularity.desc";
const archiveSourceCache = new Map();
const tmdbMovieListRequests = new Map();
const discoveryState = {
    genreId: "",
    sortBy: DISCOVERY_DEFAULT_SORT,
    page: 0,
    totalPages: 0,
    movies: [],
    isLoading: false,
    requestVersion: 0
};

const firebaseApp = isFirebaseConfigured
    ? (getApps().length ? getApp() : initializeApp(firebaseConfig))
    : null;
const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;
const firestore = firebaseApp ? getFirestore(firebaseApp) : null;
let currentUser = null;
let activeMovieId = null;
let activeWatchlistButton = null;
let activeReviewMovie = null;
let activeReviews = [];
let watchlistRenderVersion = 0;
let currentHistoryMovie = null;
let watchHistorySaveTimer = null;
let watchHistoryLastSavedAt = 0;
let homeRecommendationsUserId = null;
let homeRecommendationsPromise = null;
let homeRecommendationsRequestVersion = 0;
let resolveAuthState;
const authStateReady = new Promise(resolve => {
    resolveAuthState = resolve;
});

if (firebaseAuth) {
    onAuthStateChanged(firebaseAuth, user => {
        currentUser = user;
        resolveAuthState(user);
        console.info("Watchlist authentication state changed:", user
            ? { uid: user.uid, email: user.email }
            : "signed out");

        if (activeWatchlistButton && activeMovieId !== null) {
            updateWatchlistButton(activeWatchlistButton, activeMovieId).catch(error => {
                console.error("Error refreshing the movie watchlist button:", error);
            });
        }

        if (activeReviewMovie) {
            renderReviews(activeReviewMovie, activeReviews);
        }

        renderWatchlist();
        loadHomeWatchHistory();
        loadHomeRecommendations();
    });
} else {
    resolveAuthState(null);
}

/// =========================
// LEGAL MOVIE LIBRARY
// =========================

const movieLibrary = [

    {
        tmdbId: 10331,
        title: "Night of the Living Dead",
        videoUrl: "https://dn601206.us.archive.org/0/items/night-of-the-living-dead-1968-english/Night%20of%20the%20Living%20Dead%20%281968%29%20English.mp4",
        type: "video/mp4",
        source: "Internet Archive"
    }

];

function findLegalMovie(tmdbId) {

    return movieLibrary.find(movie =>
        String(movie.tmdbId) === String(tmdbId)
    );

}

async function getTmdbMovie(tmdbId) {

    const response = await fetch(
        `${API_URL}/movie/${tmdbId}?api_key=${API_KEY}&language=en-US`
    );

    if (!response.ok) {
        throw new Error(`Could not load TMDB movie ${tmdbId}.`);
    }

    return response.json();

}

function normalizeArchiveTitle(value = "") {

    return String(value)
        .toLowerCase()
        .replace(/\b(18|19|20)\d{2}\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");

}

function getArchiveRuntimeMinutes(value, numericUnit = "minutes") {

    if (typeof value === "number" && Number.isFinite(value)) {
        return numericUnit === "seconds" || value > 1000 ? value / 60 : value;
    }

    const runtime = String(value || "").trim().toLowerCase();
    const clockParts = runtime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

    if (clockParts) {
        const hours = clockParts[3] === undefined ? 0 : Number(clockParts[1]);
        const minutes = clockParts[3] === undefined ? Number(clockParts[1]) : Number(clockParts[2]);
        const seconds = clockParts[3] === undefined ? Number(clockParts[2]) : Number(clockParts[3]);
        return hours * 60 + minutes + seconds / 60;
    }

    const minuteValue = runtime.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min)\b/);
    if (minuteValue) {
        return Number(minuteValue[1]);
    }

    const hourValue = runtime.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr)\b/);
    if (hourValue) {
        return Number(hourValue[1]) * 60;
    }

    if (/^\d+(?:\.\d+)?$/.test(runtime)) {
        const numericRuntime = Number(runtime);
        return numericUnit === "seconds" || numericRuntime > 1000
            ? numericRuntime / 60
            : numericRuntime;
    }

    return null;

}

function getArchiveVideoType(fileName = "") {

    return String(fileName).toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4";

}

function findPlayableInternetArchiveFile(itemData, preferredFileName = "") {

    if (!itemData || !Array.isArray(itemData.files)) {
        return null;
    }

    const rejectedFileTerms = /(?:trailer|teaser|preview|sample|thumbnail|thumb|poster|subtitle|\.srt\b|\.vtt\b|\.torrent\b|\.zip\b|\.mp3\b|\.jpg\b|\.png\b)/i;
    const playableFiles = itemData.files.filter(file => {
        const fileName = String(file?.name || file?.original || "");
        const mimeType = String(file?.mimetype || file?.format || "").toLowerCase();
        const extensionIsVideo = /\.(mp4|m4v|webm)$/i.test(fileName);
        const mimeIsVideo = /video\/(mp4|webm|x-m4v)/.test(mimeType);
        const mimeConflictsWithVideo = /audio|image|text|zip|torrent|subtitle|jpeg|png|gif/i.test(mimeType);
        const fileSize = Number(file?.size || file?.length || 0);

        return fileName
            && !rejectedFileTerms.test(fileName)
            && (extensionIsVideo || mimeIsVideo)
            && !mimeConflictsWithVideo
            && fileSize >= 15 * 1024 * 1024;
    });

    playableFiles.sort((left, right) => {
        const score = file => {
            const name = String(file.name || file.original || "").toLowerCase();
            const size = Number(file.size || file.length || 0);
            const resolution = Number(name.match(/(?:^|[._-])(\d{3,4})p(?:[._-]|$)/)?.[1] || 0);
            return (name.endsWith(".mp4") ? 1000000 : 0) + resolution * 1000 + Math.min(size, 999999);
        };
        return score(right) - score(left);
    });

    const preferredFile = preferredFileName
        ? playableFiles.find(file => String(file.name || file.original || "") === preferredFileName)
        : null;
    if (preferredFileName && !preferredFile) {
        return null;
    }

    const selectedFile = preferredFile || playableFiles[0];
    const fileName = String(selectedFile?.name || selectedFile?.original || "");
    const identifier = String(itemData.metadata?.identifier || itemData.identifier || "");

    if (!fileName || !identifier) {
        return null;
    }

    return {
        identifier,
        fileName,
        url: `${INTERNET_ARCHIVE_URL}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(fileName)}`,
        type: getArchiveVideoType(fileName),
        format: fileName.split(".").pop()?.toUpperCase() || "VIDEO"
    };

}

async function fetchInternetArchiveJson(url) {

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Internet Archive request failed with status ${response.status}.`);
        }
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }

}

async function getInternetArchiveItemMetadata(identifier) {

    if (!identifier) {
        throw new Error("An Internet Archive item identifier is required.");
    }

    return fetchInternetArchiveJson(`${INTERNET_ARCHIVE_URL}/metadata/${encodeURIComponent(identifier)}`);

}

async function searchInternetArchiveCandidates(title, year) {

    const safeTitle = String(title || "").replace(/[\\"']/g, " ").trim();
    if (!safeTitle) {
        return [];
    }

    const yearClause = /^\d{4}$/.test(String(year || "")) ? ` AND year:${year}` : "";
    const params = new URLSearchParams({
        q: `mediatype:movies AND title:"${safeTitle}"${yearClause}`,
        rows: "5",
        output: "json",
        fl: "identifier,title,description,subject,year,date"
    });
    const data = await fetchInternetArchiveJson(`${INTERNET_ARCHIVE_URL}/advancedsearch.php?${params.toString()}`);
    return Array.isArray(data?.response?.docs) ? data.response.docs : [];

}

function validateArchiveCandidate(movie, document, itemData, preferredFileName = "") {

    const movieId = String(movie?.id || "");
    const identifier = String(document?.identifier || itemData?.metadata?.identifier || itemData?.identifier || "");
    const archiveMetadata = itemData?.metadata || {};
    const archiveTitle = String(archiveMetadata.title || document?.title || "");
    const expectedTitles = [movie?.title, movie?.original_title]
        .filter(Boolean)
        .map(normalizeArchiveTitle)
        .filter(Boolean);
    const normalizedArchiveTitle = normalizeArchiveTitle(archiveTitle);
    const exactTitleMatch = expectedTitles.some(title => normalizedArchiveTitle === title
        || normalizedArchiveTitle.startsWith(`${title} `));

    if (!movieId || !identifier || !exactTitleMatch) {
        return null;
    }

    const releaseYear = String(movie?.release_date || "").slice(0, 4);
    if (!/^\d{4}$/.test(releaseYear)) {
        return null;
    }

    const yearText = [archiveTitle, archiveMetadata.year, archiveMetadata.date, document?.year, document?.date]
        .flat()
        .join(" ");
    const archiveYears = yearText.match(/\b(?:18|19|20)\d{2}\b/g) || [];
    if (!archiveYears.includes(releaseYear)) {
        return null;
    }

    const playableFile = findPlayableInternetArchiveFile(itemData, preferredFileName);
    if (!playableFile) {
        return null;
    }

    const selectedFileEntry = itemData.files.find(file => String(file?.name || file?.original || "") === playableFile.fileName);
    const runtimeMinutes = getArchiveRuntimeMinutes(archiveMetadata.runtime)
        ?? getArchiveRuntimeMinutes(document?.runtime)
        ?? getArchiveRuntimeMinutes(archiveMetadata.length, "seconds")
        ?? getArchiveRuntimeMinutes(document?.length, "seconds")
        ?? getArchiveRuntimeMinutes(selectedFileEntry?.length, "seconds");
    if (!Number.isFinite(runtimeMinutes) || runtimeMinutes < 40) {
        return null;
    }

    const titleCues = /\b(trailer|teaser|clip|preview|sample|interview|promo|advertisement|behind the scenes|making of|deleted scenes?|featurettes?|bloopers?)\b/i;
    const supportingText = [archiveMetadata.description, archiveMetadata.subject, document?.description, document?.subject]
        .flat()
        .filter(Boolean)
        .join(" ");
    const supportingCues = supportingText.match(/\b(trailer|teaser|clip|preview|sample|interview|promo|advertisement|behind the scenes|making of|deleted scenes?|featurettes?|bloopers?)\b/gi) || [];

    const collectionValues = [archiveMetadata.collection, archiveMetadata.mediatype, itemData.metadata?.source]
        .flat()
        .filter(Boolean)
        .join(" ");
    const isMirroredSocialVideo = /\b(deemphasize|mirrortube|social-media-video)\b/i.test(collectionValues);

    if (isMirroredSocialVideo || titleCues.test(archiveTitle) || (supportingCues.length >= 2 && runtimeMinutes < 70)) {
        return null;
    }

    return {
        tmdbId: movieId,
        title: movie.title || archiveTitle,
        archiveId: identifier,
        identifier,
        videoUrl: playableFile.url,
        url: playableFile.url,
        fileName: playableFile.fileName,
        type: playableFile.type,
        source: "Internet Archive",
        duration: runtimeMinutes,
        runtimeMinutes,
        year: releaseYear,
        rightsVerified: false
    };

}

function getExistingMovieSource(movie) {

    const existingMovie = findLegalMovie(movie?.id);
    if (!existingMovie) {
        return null;
    }

    return {
        tmdbId: String(movie.id),
        title: movie.title || existingMovie.title,
        archiveId: `curated-${existingMovie.tmdbId}`,
        identifier: `curated-${existingMovie.tmdbId}`,
        videoUrl: existingMovie.videoUrl,
        url: existingMovie.videoUrl,
        fileName: "",
        type: existingMovie.type,
        source: existingMovie.source,
        duration: null,
        runtimeMinutes: null,
        year: String(movie.release_date || "").slice(0, 4),
        rightsVerified: true,
        isExistingSource: true
    };

}

async function resolveArchiveSourceForMovie(movie) {

    const existingSource = getExistingMovieSource(movie);
    if (existingSource) {
        return existingSource;
    }

    const titles = [...new Set([movie?.title, movie?.original_title].filter(Boolean))];
    if (!movie?.id || !titles.length) {
        return null;
    }

    try {
        const releaseYear = String(movie?.release_date || "").slice(0, 4);
        const resultLists = await Promise.all(titles.slice(0, 2).map(title =>
            searchInternetArchiveCandidates(title, releaseYear)
        ));
        const documents = [...new Map(resultLists.flat()
            .filter(document => document?.identifier)
            .map(document => [String(document.identifier), document])).values()].slice(0, 6);

        const validatedSources = (await Promise.all(documents.map(async document => {
            try {
                const itemData = await getInternetArchiveItemMetadata(document.identifier);
                return validateArchiveCandidate(movie, document, itemData);
            } catch (error) {
                console.warn("Skipping unavailable Internet Archive metadata:", document.identifier, error);
                return null;
            }
        }))).filter(Boolean);

        return validatedSources[0] || null;
    } catch (error) {
        console.warn("Internet Archive source lookup failed:", error);
        return null;
    }

}

function findPlayableArchiveSourceForMovie(movie) {

    const cacheKey = String(movie?.id || "");
    if (!cacheKey) {
        return Promise.resolve(null);
    }

    if (!archiveSourceCache.has(cacheKey)) {
        archiveSourceCache.set(cacheKey, resolveArchiveSourceForMovie(movie));
    }

    return archiveSourceCache.get(cacheKey);

}


// =========================
// WATCHLIST STORAGE
// =========================

function getWatchlist() {

    try {

        const savedWatchlist = localStorage.getItem(WATCHLIST_KEY);

        if (!savedWatchlist) {
            return [];
        }

        const watchlist = JSON.parse(savedWatchlist);
        return Array.isArray(watchlist) ? watchlist : [];

    } catch (error) {

        console.error("Error reading the watchlist:", error);
        return [];

    }

}

function getUserWatchlistReference(user) {

    if (!firestore || !user) {
        throw new Error("A signed-in Firebase user is required for Firestore watchlists.");
    }

    return collection(firestore, "users", user.uid, "watchlist");

}

function getUserMovieReference(user, movieId) {

    return doc(getUserWatchlistReference(user), String(movieId));

}

function getMovieWatchlistData(movie) {

    return {
        id: movie.id,
        title: movie.title,
        poster_path: movie.poster_path || null,
        vote_average: movie.vote_average,
        release_date: movie.release_date || ""
    };

}

async function getFirestoreWatchlist(user) {

    const watchlistPath = `users/${user.uid}/watchlist`;

    console.info("Loading Firestore watchlist:", {
        projectId: firebaseConfig.projectId,
        path: watchlistPath,
        uid: user.uid
    });

    const snapshot = await getDocs(getUserWatchlistReference(user));
    return snapshot.docs.map(movieDocument => ({
        ...movieDocument.data(),
        id: movieDocument.data().id ?? movieDocument.id
    }));

}

function deduplicateWatchlist(watchlist) {

    const uniqueMovies = new Map();

    watchlist.forEach(movie => {
        const movieId = String(movie.id);

        if (movieId && !uniqueMovies.has(movieId)) {
            uniqueMovies.set(movieId, movie);
        }
    });

    return [...uniqueMovies.values()];

}

function getFirestoreWatchlistErrorMessage(error) {

    switch (error?.code) {
        case "permission-denied":
            return "Firestore denied access to this watchlist. Deploy firestore.rules and make sure you are signed in.";
        case "unavailable":
            return "Firestore is temporarily unavailable. Check your connection and try again.";
        case "failed-precondition":
            return "Firestore is not ready for this project. Check that the Firestore database is enabled.";
        default:
            return "We could not load your watchlist. Check your connection and Firestore security rules.";
    }

}

async function getWatchlistForCurrentUser(useLocalFallback = false) {

    await authStateReady;

    if (currentUser) {
        return getFirestoreWatchlist(currentUser);
    }

    return useLocalFallback ? getWatchlist() : [];

}

function saveWatchlist(watchlist) {

    try {

        localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
        return true;

    } catch (error) {

        console.error("Error saving the watchlist:", error);
        return false;

    }

}

function getReviewCollectionReference(movieId) {

    if (!firestore) {
        throw new Error("Firebase Firestore is not configured.");
    }

    return collection(firestore, "movies", String(movieId), "reviews");

}

function getReviewReference(movieId, userId) {

    return doc(getReviewCollectionReference(movieId), userId);

}

function getReviewDate(review) {

    if (!review.createdAt?.toDate) {
        return "Recently";
    }

    return review.createdAt.toDate().toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric"
    });

}

function getReviewAuthor(review) {

    if (review.userEmail) {
        const [name] = review.userEmail.split("@");
        return name || "MovieFlix user";
    }

    return "MovieFlix user";

}

function renderReviewStars(rating) {

    return Array.from({ length: 5 }, (_, index) =>
        `<span class="review-star${index < rating ? " is-filled" : ""}" aria-hidden="true">★</span>`
    ).join("");

}

function renderReviews(movie, reviews) {

    const reviewsSection = document.getElementById("reviewsSection");
    const reviewsList = document.getElementById("reviewsList");
    const reviewsSummary = document.getElementById("reviewsSummary");
    const reviewForm = document.getElementById("reviewForm");
    const reviewLoginPrompt = document.getElementById("reviewLoginPrompt");
    const reviewRatingInput = document.getElementById("reviewRating");
    const reviewTextInput = document.getElementById("reviewText");
    const reviewSubmit = document.getElementById("reviewSubmit");
    const reviewCancel = document.getElementById("reviewCancel");
    const reviewDelete = document.getElementById("reviewDelete");
    const reviewFormStatus = document.getElementById("reviewFormStatus");
    const reviewEditorTitle = document.getElementById("reviewEditorTitle");

    if (!reviewsSection || !reviewsList || !reviewsSummary) {
        return;
    }

    const uniqueReviews = new Map();

    reviews.forEach(review => {
        const reviewId = String(review.uid || review.id || "");

        if (reviewId && !uniqueReviews.has(reviewId)) {
            uniqueReviews.set(reviewId, review);
        }
    });

    const visibleReviews = [...uniqueReviews.values()];
    const average = visibleReviews.length
        ? visibleReviews.reduce((total, review) => total + Number(review.rating || 0), 0) / visibleReviews.length
        : 0;

    reviewsSummary.innerHTML = visibleReviews.length
        ? `<strong>${average.toFixed(1)}</strong><span class="review-summary-stars">${renderReviewStars(Math.round(average))}</span><span>${visibleReviews.length} ${visibleReviews.length === 1 ? "review" : "reviews"}</span>`
        : "No reviews yet. Be the first to share your thoughts.";

    reviewsList.innerHTML = "";

    visibleReviews.forEach(review => {
        const reviewArticle = document.createElement("article");
        const reviewHeading = document.createElement("div");
        const reviewer = document.createElement("div");
        const reviewerName = document.createElement("strong");
        const reviewDate = document.createElement("span");
        const reviewStars = document.createElement("div");
        const reviewText = document.createElement("p");

        reviewArticle.className = "review-item";
        reviewHeading.className = "review-item-heading";
        reviewStars.className = "review-stars";
        reviewStars.setAttribute("aria-label", `Rated ${review.rating} out of 5`);
        reviewerName.textContent = getReviewAuthor(review);
        reviewDate.textContent = getReviewDate(review);
        reviewStars.innerHTML = renderReviewStars(Number(review.rating));
        reviewText.textContent = review.text;
        reviewer.append(reviewerName, reviewDate);
        reviewHeading.append(reviewer, reviewStars);
        reviewArticle.append(reviewHeading, reviewText);
        reviewsList.appendChild(reviewArticle);
    });

    const ownReview = currentUser
        ? visibleReviews.find(review => review.uid === currentUser.uid)
        : null;

    if (currentUser) {
        reviewForm.hidden = false;
        reviewLoginPrompt.hidden = true;
        reviewEditorTitle.textContent = ownReview ? "Edit your review" : "Rate this movie";
        reviewSubmit.textContent = ownReview ? "Update Review" : "Publish Review";
        reviewCancel.hidden = !ownReview;
        reviewDelete.hidden = !ownReview;

        if (document.activeElement !== reviewTextInput && ownReview) {
            reviewRatingInput.value = String(ownReview.rating);
            reviewTextInput.value = ownReview.text;
        }
    } else {
        reviewForm.hidden = true;
        reviewLoginPrompt.hidden = false;
    }

    reviewsSection.hidden = false;

}

async function loadReviews(movie) {

    const reviewsSection = document.getElementById("reviewsSection");
    const reviewsStatus = document.getElementById("reviewsStatus");
    const reviewsList = document.getElementById("reviewsList");

    if (!reviewsStatus || !reviewsList) {
        return;
    }

    activeReviewMovie = movie;
    activeReviews = [];
    reviewsSection.hidden = false;
    renderReviews(movie, activeReviews);
    reviewsStatus.textContent = "Loading reviews...";

    try {
        const snapshot = await getDocs(getReviewCollectionReference(movie.id));
        activeReviews = snapshot.docs.map(reviewDocument => ({
            ...reviewDocument.data(),
            id: reviewDocument.id
        }));
        reviewsStatus.textContent = "";
        renderReviews(movie, activeReviews);
    } catch (error) {
        console.error("Error loading movie reviews:", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            movieId: movie.id,
            path: `movies/${movie.id}/reviews`,
            error
        });
        reviewsStatus.textContent = "Reviews could not load right now.";
        renderReviews(movie, activeReviews);
    }

}

function setupReviewForm(movie) {

    const reviewForm = document.getElementById("reviewForm");
    const ratingInput = document.getElementById("reviewRating");
    const textInput = document.getElementById("reviewText");
    const submitButton = document.getElementById("reviewSubmit");
    const cancelButton = document.getElementById("reviewCancel");
    const reviewDelete = document.getElementById("reviewDelete");
    const status = document.getElementById("reviewFormStatus");

    if (!reviewForm || !ratingInput || !textInput || !submitButton || !status) {
        return;
    }

    reviewForm.addEventListener("submit", async event => {
        event.preventDefault();

        if (!currentUser) {
            status.textContent = "Log in to submit a review.";
            return;
        }

        const rating = Number(ratingInput.value);
        const text = textInput.value.trim();

        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            status.textContent = "Choose a rating from 1 to 5 stars.";
            return;
        }

        if (!text) {
            status.textContent = "Write a review before publishing.";
            return;
        }

        submitButton.disabled = true;
        status.textContent = "Saving your review...";

        try {
            const reviewReference = getReviewReference(movie.id, currentUser.uid);
            const existingReview = await getDoc(reviewReference);
            const reviewData = {
                uid: currentUser.uid,
                movieId: String(movie.id),
                rating,
                text,
                userEmail: currentUser.email || "MovieFlix user",
                ...(existingReview.exists()
                    ? { updatedAt: serverTimestamp() }
                    : { createdAt: serverTimestamp() })
            };

            await setDoc(reviewReference, reviewData, { merge: true });
            status.textContent = "Review saved.";
            await loadReviews(movie);
        } catch (error) {
            console.error("Error saving movie review:", {
                code: error?.code || "unknown",
                message: error?.message || String(error),
                movieId: movie.id,
                uid: currentUser.uid,
                path: `movies/${movie.id}/reviews/${currentUser.uid}`,
                error
            });
            status.textContent = error?.code === "permission-denied"
                ? "Firebase denied this review. Deploy the current firestore.rules and try again."
                : "We could not save your review. Please try again.";
        } finally {
            submitButton.disabled = false;
        }
    });

    cancelButton?.addEventListener("click", () => {
        const ownReview = activeReviews.find(review => review.uid === currentUser?.uid);

        if (ownReview) {
            ratingInput.value = String(ownReview.rating);
            textInput.value = ownReview.text;
        }

        status.textContent = "Editing cancelled.";
    });

    reviewDelete?.addEventListener("click", async () => {
        reviewDelete.disabled = true;
        await deleteOwnReview(movie);
        reviewDelete.disabled = false;
    });

}

async function deleteOwnReview(movie) {

    if (!currentUser) {
        return;
    }

    try {
        await deleteDoc(getReviewReference(movie.id, currentUser.uid));
        document.getElementById("reviewFormStatus").textContent = "Review deleted.";
        document.getElementById("reviewText").value = "";
        document.getElementById("reviewRating").value = "5";
        await loadReviews(movie);
    } catch (error) {
        console.error("Error deleting movie review:", error);
        document.getElementById("reviewFormStatus").textContent = "We could not delete your review.";
    }

}

async function isMovieInWatchlist(movieId) {

    await authStateReady;

    if (currentUser) {
        const movieDocument = await getDoc(getUserMovieReference(currentUser, movieId));
        return movieDocument.exists();
    }

    return getWatchlist().some(movie =>
        String(movie.id) === String(movieId)
    );

}

async function addMovieToWatchlist(movie) {

    await authStateReady;

    const movieData = getMovieWatchlistData(movie);

    if (currentUser) {
        await setDoc(getUserMovieReference(currentUser, movie.id), movieData);
        console.info("Movie added to the user's Firestore watchlist:", movieData.id);
        return true;
    }

    const watchlist = getWatchlist();

    if (watchlist.some(savedMovie => String(savedMovie.id) === String(movie.id))) {
        return false;
    }

    watchlist.unshift(movieData);

    return saveWatchlist(watchlist);

}

async function removeMovieFromWatchlist(movieId) {

    await authStateReady;

    if (currentUser) {
        await deleteDoc(getUserMovieReference(currentUser, movieId));
        console.info("Movie removed from the user's Firestore watchlist:", String(movieId));
        return true;
    }

    const watchlist = getWatchlist();
    const updatedWatchlist = watchlist.filter(movie =>
        String(movie.id) !== String(movieId)
    );

    return saveWatchlist(updatedWatchlist);

}

function getUserHistoryReference(user) {

    if (!firestore || !user) {
        throw new Error("A signed-in Firebase user is required for Firestore watch history.");
    }

    return collection(firestore, "users", user.uid, "watchHistory");

}

function getUserHistoryMovieReference(user, movieId) {

    return doc(getUserHistoryReference(user), String(movieId));

}

function normalizeHistoryDocument(snapshotDocument) {

    if (!snapshotDocument || typeof snapshotDocument !== "object") {
        return null;
    }

    const data = snapshotDocument.data ? snapshotDocument.data() : snapshotDocument;

    if (!data || typeof data !== "object") {
        return null;
    }

    const normalized = {
        movieId: String(snapshotDocument.id || data.movieId || ""),
        title: typeof data.title === "string" && data.title.trim() ? data.title : "Movie",
        posterPath: typeof data.posterPath === "string" ? data.posterPath : "",
        progressSeconds: Number.isFinite(Number(data.progressSeconds)) ? Number(data.progressSeconds) : 0,
        durationSeconds: Number.isFinite(Number(data.durationSeconds)) ? Number(data.durationSeconds) : 0,
        progressPercent: Number.isFinite(Number(data.progressPercent)) ? Number(data.progressPercent) : 0,
        completed: Boolean(data.completed),
        lastWatchedAt: data.lastWatchedAt || null
    };

    if (!normalized.movieId) {
        return null;
    }

    return normalized;

}

async function getUserWatchHistoryDocuments() {

    await authStateReady;

    if (!currentUser || !firestore) {
        return [];
    }

    try {
        const snapshot = await getDocs(getUserHistoryReference(currentUser));
        const historyDocuments = snapshot.docs
            .map(normalizeHistoryDocument)
            .filter(Boolean);

        historyDocuments.sort((left, right) => {
            const leftTimestamp = left.lastWatchedAt?.toDate ? left.lastWatchedAt.toDate().getTime() : 0;
            const rightTimestamp = right.lastWatchedAt?.toDate ? right.lastWatchedAt.toDate().getTime() : 0;
            return rightTimestamp - leftTimestamp;
        });

        return historyDocuments;
    } catch (error) {
        console.error("Error loading the user's watch history:", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            uid: currentUser.uid,
            path: `users/${currentUser.uid}/watchHistory`,
            error
        });
        return [];
    }

}

async function deleteMovieFromHistory(movieId) {

    await authStateReady;

    if (!currentUser || !firestore) {
        return false;
    }

    try {
        await deleteDoc(getUserHistoryMovieReference(currentUser, movieId));
        await loadHomeWatchHistory();
        return true;
    } catch (error) {
        console.error("Error deleting movie history:", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            movieId: String(movieId),
            uid: currentUser.uid,
            path: `users/${currentUser.uid}/watchHistory/${movieId}`,
            error
        });
        return false;
    }

}

async function clearUserWatchHistory() {

    await authStateReady;

    if (!currentUser || !firestore) {
        return false;
    }

    const historyDocuments = await getUserWatchHistoryDocuments();

    if (!historyDocuments.length) {
        return false;
    }

    if (!window.confirm("Clear all of your watch history? This cannot be undone.")) {
        return false;
    }

    try {
        await Promise.all(historyDocuments.map(historyDocument =>
            deleteDoc(getUserHistoryMovieReference(currentUser, historyDocument.movieId))
        ));

        await loadHomeWatchHistory();
        return true;
    } catch (error) {
        console.error("Error clearing watch history:", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            uid: currentUser.uid,
            path: `users/${currentUser.uid}/watchHistory`,
            error
        });
        return false;
    }

}

function renderHistoryPoster(posterPath) {

    if (!posterPath) {
        return `
            <div class="movie-poster movie-poster-placeholder" role="img" aria-label="Poster unavailable">
                No poster available
            </div>
        `;
    }

    return `
        <div class="history-poster">
            <img src="${IMAGE_URL}${posterPath}" alt="Movie poster" loading="lazy">
        </div>
    `;

}

function renderContinueWatchingCards(historyDocuments) {

    const container = document.getElementById("continueWatchingMovies");
    const status = document.getElementById("continueWatchingStatus");

    if (!container || !status) {
        return;
    }

    container.innerHTML = "";

    const continueWatching = historyDocuments.filter(historyDocument => {
        const hasProgress = Number.isFinite(historyDocument.progressPercent)
            && historyDocument.progressPercent > 0
            && historyDocument.progressPercent < 100;
        const hasValidDuration = Number.isFinite(historyDocument.durationSeconds)
            && historyDocument.durationSeconds > 0;
        return !historyDocument.completed && hasProgress && hasValidDuration && historyDocument.progressSeconds > 0;
    });

    if (!continueWatching.length) {
        status.className = "section-status is-empty";
        status.textContent = "No movies to continue watching yet.";
        return;
    }

    status.className = "section-status is-ready";
    status.textContent = "";

    continueWatching.forEach(historyDocument => {
        const card = document.createElement("article");
        const cardBody = document.createElement("div");
        const title = document.createElement("h3");
        const label = document.createElement("div");
        const bar = document.createElement("div");
        const progress = document.createElement("span");

        card.className = "history-card";
        card.setAttribute("role", "link");
        card.tabIndex = 0;
        cardBody.className = "history-body";
        title.textContent = historyDocument.title || "Movie";
        label.className = "history-progress-label";
        label.innerHTML = `<span>Progress</span><span>${Math.round(historyDocument.progressPercent)}%</span>`;
        bar.className = "history-progress-bar";
        progress.style.width = `${Math.min(100, Math.max(0, historyDocument.progressPercent))}%`;
        bar.appendChild(progress);
        cardBody.append(title, label, bar);
        card.innerHTML = renderHistoryPoster(historyDocument.posterPath);
        card.appendChild(cardBody);

        card.addEventListener("click", () => {
            window.location.href = `watch.html?id=${historyDocument.movieId}`;
        });

        card.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                card.click();
            }
        });

        container.appendChild(card);
    });

}

function renderRecentlyWatchedCards(historyDocuments) {

    const container = document.getElementById("recentlyWatchedMovies");
    const status = document.getElementById("recentlyWatchedStatus");
    const clearButton = document.getElementById("clearHistoryButton");

    if (!container || !status) {
        return;
    }

    const recentlyWatched = [...historyDocuments]
        .filter(historyDocument => historyDocument.progressSeconds >= 0)
        .sort((left, right) => {
            const leftTimestamp = left.lastWatchedAt?.toDate ? left.lastWatchedAt.toDate().getTime() : 0;
            const rightTimestamp = right.lastWatchedAt?.toDate ? right.lastWatchedAt.toDate().getTime() : 0;
            return rightTimestamp - leftTimestamp;
        });

    container.innerHTML = "";

    if (!recentlyWatched.length) {
        status.className = "section-status is-empty";
        status.textContent = "You haven't watched any movies yet.";
        if (clearButton) {
            clearButton.hidden = true;
        }
        return;
    }

    status.className = "section-status is-ready";
    status.textContent = "";

    if (clearButton) {
        clearButton.hidden = false;
    }

    recentlyWatched.forEach(historyDocument => {
        const card = document.createElement("article");
        const removeButton = document.createElement("button");
        const body = document.createElement("div");
        const title = document.createElement("h3");
        const meta = document.createElement("div");

        card.className = "history-card";
        card.setAttribute("role", "link");
        card.tabIndex = 0;
        card.innerHTML = renderHistoryPoster(historyDocument.posterPath);

        removeButton.type = "button";
        removeButton.className = "history-remove-button";
        removeButton.textContent = "×";
        removeButton.setAttribute("aria-label", `Remove ${historyDocument.title} from history`);
        removeButton.addEventListener("click", async event => {
            event.preventDefault();
            event.stopPropagation();
            removeButton.disabled = true;
            const didDelete = await deleteMovieFromHistory(historyDocument.movieId);
            if (!didDelete) {
                removeButton.disabled = false;
            }
        });

        body.className = "history-body";
        title.textContent = historyDocument.title || "Movie";
        meta.className = "history-meta";
        meta.textContent = historyDocument.lastWatchedAt?.toDate
            ? historyDocument.lastWatchedAt.toDate().toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric"
            })
            : "Recently watched";
        body.append(title, meta);
        card.append(removeButton, body);

        card.addEventListener("click", () => {
            window.location.href = `movie.html?id=${historyDocument.movieId}`;
        });

        card.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                card.click();
            }
        });

        container.appendChild(card);
    });

}

async function loadHomeWatchHistory() {

    const continueStatus = document.getElementById("continueWatchingStatus");
    const recentStatus = document.getElementById("recentlyWatchedStatus");
    const clearButton = document.getElementById("clearHistoryButton");

    if (!continueStatus || !recentStatus) {
        return;
    }

    await authStateReady;

    if (!currentUser || !firestore) {
        document.getElementById("continueWatchingMovies")?.replaceChildren();
        document.getElementById("recentlyWatchedMovies")?.replaceChildren();
        continueStatus.className = "section-status is-empty";
        recentStatus.className = "section-status is-empty";
        continueStatus.textContent = "Sign in to see your watch progress.";
        recentStatus.textContent = "Sign in to see your recent movies.";
        if (clearButton) {
            clearButton.hidden = true;
        }
        return;
    }

    const historyDocuments = await getUserWatchHistoryDocuments();
    renderContinueWatchingCards(historyDocuments);
    renderRecentlyWatchedCards(historyDocuments);

    if (clearButton) {
        clearButton.hidden = !historyDocuments.length;
        clearButton.onclick = async () => {
            const didClear = await clearUserWatchHistory();
            if (didClear) {
                clearButton.hidden = true;
            }
        };
    }

}

async function saveCurrentWatchHistory({ force = false, completed = false } = {}) {

    await authStateReady;

    if (!currentUser || !firestore || !currentHistoryMovie) {
        return;
    }

    const moviePlayer = document.getElementById("moviePlayer");
    const searchParams = new URLSearchParams(window.location.search);
    const movieId = searchParams.get("id") || searchParams.get("iaId");

    if (!moviePlayer || !movieId) {
        return;
    }

    const currentTime = Number(moviePlayer.currentTime);
    const durationSeconds = Number(moviePlayer.duration);

    if (!Number.isFinite(currentTime) || currentTime < 0) {
        return;
    }

    const safeProgress = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.min(Math.max(currentTime, 0), durationSeconds)
        : Math.max(currentTime, 0);

    const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : 0;

    const progressPercent = safeDuration > 0
        ? Math.min(100, Math.max(0, (safeProgress / safeDuration) * 100))
        : 0;

    const shouldMarkComplete = Boolean(completed)
        || (safeDuration > 0 && safeProgress >= safeDuration - 0.5);

    const historyDocument = {
        movieId: String(movieId),
        title: currentHistoryMovie.title || "Movie",
        posterPath: currentHistoryMovie.poster_path || "",
        progressSeconds: Number(safeProgress.toFixed(1)),
        durationSeconds: Number(safeDuration.toFixed(1)),
        progressPercent: Number(Math.min(100, Math.max(0, shouldMarkComplete ? 100 : progressPercent)).toFixed(1)),
        lastWatchedAt: serverTimestamp(),
        completed: shouldMarkComplete
    };

    if (shouldMarkComplete) {
        historyDocument.progressSeconds = Number(safeDuration.toFixed(1));
        historyDocument.progressPercent = 100;
    }

    const timedSaveWindow = Date.now() - watchHistoryLastSavedAt;

    if (!force && !completed && timedSaveWindow < 9000) {
        clearTimeout(watchHistorySaveTimer);
        watchHistorySaveTimer = window.setTimeout(() => {
            saveCurrentWatchHistory({ force: true });
        }, 9000 - timedSaveWindow);
        return;
    }

    try {
        await setDoc(getUserHistoryMovieReference(currentUser, movieId), historyDocument, { merge: true });
        watchHistoryLastSavedAt = Date.now();
    } catch (error) {
        console.error("Error saving watch progress:", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            movieId: String(movieId),
            uid: currentUser.uid,
            path: `users/${currentUser.uid}/watchHistory/${movieId}`,
            error
        });
    }

}

function scheduleWatchHistorySave({ force = false, completed = false } = {}) {

    if (!currentUser || !currentHistoryMovie) {
        return;
    }

    if (force || completed) {
        saveCurrentWatchHistory({ force: true, completed });
        return;
    }

    const elapsedSinceLastSave = Date.now() - watchHistoryLastSavedAt;

    clearTimeout(watchHistorySaveTimer);

    if (elapsedSinceLastSave >= 9000) {
        saveCurrentWatchHistory({ force: true });
        return;
    }

    watchHistorySaveTimer = window.setTimeout(() => {
        saveCurrentWatchHistory({ force: true });
    }, 9000 - elapsedSinceLastSave);

}

async function restoreWatchHistoryProgress(movieId, durationSeconds) {

    await authStateReady;

    if (!currentUser || !firestore || !movieId || !Number.isFinite(durationSeconds)) {
        return false;
    }

    try {
        const historyDocument = await getDoc(getUserHistoryMovieReference(currentUser, movieId));

        if (!historyDocument.exists()) {
            return false;
        }

        const savedHistory = normalizeHistoryDocument(historyDocument);

        if (!savedHistory || savedHistory.completed || savedHistory.progressSeconds <= 0) {
            return false;
        }

        if (savedHistory.durationSeconds > 0 && savedHistory.progressSeconds >= savedHistory.durationSeconds - 1) {
            return false;
        }

        const safeCurrentTime = Number(savedHistory.progressSeconds);

        if (!Number.isFinite(safeCurrentTime) || safeCurrentTime <= 0 || safeCurrentTime >= durationSeconds) {
            return false;
        }

        const videoElement = document.getElementById("moviePlayer");

        if (!videoElement) {
            return false;
        }

        videoElement.currentTime = safeCurrentTime;
        return true;
    } catch (error) {
        console.error("Error restoring watch history:", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            movieId: String(movieId),
            uid: currentUser.uid,
            path: `users/${currentUser.uid}/watchHistory/${movieId}`,
            error
        });
        return false;
    }

}

console.log("TMDB API is ready!");


function setMovieSectionState(containerId, statusId, state, message) {

    const container = document.getElementById(containerId);
    const status = document.getElementById(statusId);

    if (!container || !status) {
        return;
    }

    container.innerHTML = "";
    status.className = `section-status is-${state}`;
    status.textContent = message;

}

function setMovieSectionReady(containerId, statusId, movies, emptyMessage, showReleaseDate = false) {

    if (!movies || movies.length === 0) {
        setMovieSectionState(containerId, statusId, "empty", emptyMessage);
        return false;
    }

    const status = document.getElementById(statusId);

    if (status) {
        status.className = "section-status is-ready";
        status.textContent = "";
    }

    displayMovies(movies, containerId, showReleaseDate);
    return true;

}

function fetchTmdbMovieList(endpoint) {
    const key = String(endpoint || "").replace(/^\/+|\/+$/g, "");
    if (!key) return Promise.resolve([]);
    if (tmdbMovieListRequests.has(key)) return tmdbMovieListRequests.get(key);

    const params = new URLSearchParams({ api_key: API_KEY, language: "en-US", page: "1" });
    const request = fetch(`${API_URL}/${key}?${params.toString()}`)
        .then(response => {
            if (!response.ok) throw new Error(`TMDB ${key} request failed with status ${response.status}.`);
            return response.json();
        })
        .then(data => Array.isArray(data?.results) ? data.results : [])
        .catch(error => {
            tmdbMovieListRequests.delete(key);
            throw error;
        });
    tmdbMovieListRequests.set(key, request);
    return request;
}

async function fetchRecommendationsForMovie(movieId) {
    const safeId = String(movieId || "").match(/^\d+$/)?.[0];
    if (!safeId) return [];

    let recommendations = [];
    try {
        recommendations = await fetchTmdbMovieList(`movie/${safeId}/recommendations`);
    } catch (error) {
        console.warn(`TMDB recommendations failed for movie ${safeId}:`, error);
    }

    if (recommendations.length >= 6) return recommendations;
    try {
        const similar = await fetchTmdbMovieList(`movie/${safeId}/similar`);
        const existingIds = new Set(recommendations.map(movie => String(movie.id)));
        return [...recommendations, ...similar.filter(movie => !existingIds.has(String(movie.id)))];
    } catch (error) {
        if (!recommendations.length) {
            console.warn(`TMDB similar movies failed for movie ${safeId}:`, error);
        }
        return recommendations;
    }
}

function isRecommendationMovie(movie) {
    return Number.isInteger(Number(movie?.id))
        && Number(movie.id) > 0
        && typeof movie?.title === "string"
        && movie.title.trim().length > 0
        && typeof movie?.poster_path === "string"
        && movie.poster_path.length > 0
        && !movie.adult;
}

function renderRecommendationList(container, status, movies, emptyMessage) {
    if (!container || !status) return false;

    const seenIds = new Set();
    const uniqueMovies = movies.filter(movie => {
        const id = String(movie?.id || "");
        if (!isRecommendationMovie(movie) || seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
    });

    container.replaceChildren(...uniqueMovies.map(movie => createMovieCard(movie, true)));
    status.className = uniqueMovies.length ? "section-status is-ready" : "section-status is-empty";
    status.textContent = uniqueMovies.length ? "" : emptyMessage;
    return uniqueMovies.length > 0;
}

async function getCurrentUserReviewPreferences(user) {
    if (!user || !firestore) return [];

    try {
        const reviewQuery = query(
            collectionGroup(firestore, "reviews"),
            where("uid", "==", user.uid),
            limit(12)
        );
        const snapshot = await getDocs(reviewQuery);
        return snapshot.docs.map(reviewDocument => {
            const review = reviewDocument.data();
            return {
                movieId: String(review.movieId || reviewDocument.ref.parent.parent?.id || ""),
                rating: Number(review.rating || 0)
            };
        }).filter(review => /^\d+$/.test(review.movieId));
    } catch (error) {
        console.warn("Could not load the current user's review preferences:", error);
        return [];
    }
}

async function getRecommendationFallbackMovies(excludedIds) {
    const popular = await fetchTmdbMovieList("movie/popular");
    const usablePopular = popular.filter(movie => isRecommendationMovie(movie) && !excludedIds.has(String(movie.id)));
    if (usablePopular.length >= 10) return usablePopular;

    try {
        const topRated = await fetchTmdbMovieList("movie/top_rated");
        const seenIds = new Set(usablePopular.map(movie => String(movie.id)));
        return [...usablePopular, ...topRated.filter(movie =>
            isRecommendationMovie(movie)
            && !excludedIds.has(String(movie.id))
            && !seenIds.has(String(movie.id))
        )];
    } catch (error) {
        console.warn("TMDB top-rated fallback failed:", error);
        return usablePopular;
    }
}

async function renderHomeRecommendations(userId, requestVersion) {
    const section = document.getElementById("homeRecommendationsSection");
    const title = document.getElementById("homeRecommendationsTitle");
    const status = document.getElementById("homeRecommendationsStatus");
    const container = document.getElementById("homeRecommendationsMovies");
    if (!section || !title || !status || !container) return;

    section.hidden = false;
    title.textContent = userId ? "Recommended For You" : "Popular Picks";
    status.className = "section-status is-loading";
    status.textContent = "Loading recommendations...";
    container.replaceChildren();

    const currentMovieId = new URLSearchParams(window.location.search).get("id");
    const excludedIds = new Set(currentMovieId ? [String(currentMovieId)] : []);
    let seeds = [];

    if (currentUser && firestore && String(currentUser.uid) === userId) {
        const [historyResult, watchlistResult, reviewsResult] = await Promise.allSettled([
            getUserWatchHistoryDocuments(),
            getFirestoreWatchlist(currentUser),
            getCurrentUserReviewPreferences(currentUser)
        ]);
        const history = historyResult.status === "fulfilled" ? historyResult.value : [];
        const watchlist = watchlistResult.status === "fulfilled" ? watchlistResult.value : [];
        const reviews = reviewsResult.status === "fulfilled" ? reviewsResult.value : [];

        history.forEach(item => excludedIds.add(String(item.movieId)));
        watchlist.forEach(item => excludedIds.add(String(item.id)));

        const seedScores = new Map();
        function addSeed(movieId, weight) {
            const id = String(movieId || "");
            if (!/^\d+$/.test(id)) return;
            seedScores.set(id, (seedScores.get(id) || 0) + weight);
        }

        history.slice(0, 6).forEach(item => addSeed(item.movieId, 4));
        watchlist.slice(0, 3).forEach(item => addSeed(item.id, 3));
        reviews.slice(0, 4).forEach(item => addSeed(item.movieId, item.rating >= 4 ? 2.5 : item.rating >= 3 ? 1.5 : 0.75));
        seeds = [...seedScores.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, 8)
            .map(([movieId, weight]) => ({ movieId, weight }));
    }

    let candidates = [];
    if (userId && seeds.length) {
        const sourceResults = await Promise.allSettled(seeds.map(async seed => ({
            ...seed,
            movies: await fetchRecommendationsForMovie(seed.movieId)
        })));
        const scores = new Map();
        sourceResults.forEach(result => {
            if (result.status !== "fulfilled") return;
            result.value.movies.forEach((movie, index) => {
                if (!isRecommendationMovie(movie)) return;
                const id = String(movie.id);
                if (excludedIds.has(id)) return;
                const candidate = scores.get(id) || { movie, score: 0, sources: 0 };
                candidate.score += result.value.weight + Math.max(0, 0.4 - index * 0.02);
                candidate.sources += 1;
                scores.set(id, candidate);
            });
        });
        candidates = [...scores.values()]
            .sort((left, right) => right.score - left.score || right.sources - left.sources)
            .map(candidate => candidate.movie);
    }

    if (!userId || candidates.length < 10) {
        try {
            const fallback = await getRecommendationFallbackMovies(excludedIds);
            const knownIds = new Set(candidates.map(movie => String(movie.id)));
            candidates = [...candidates, ...fallback.filter(movie => !knownIds.has(String(movie.id)))];
        } catch (error) {
            console.error("Could not load recommendation fallback movies:", error);
        }
    }

    if (requestVersion !== homeRecommendationsRequestVersion) return;
    const rendered = renderRecommendationList(container, status, candidates.slice(0, 12), "Recommendations are not available right now.");
    if (!rendered) section.hidden = true;
}

function loadHomeRecommendations() {
    const section = document.getElementById("homeRecommendationsSection");
    if (!section) return Promise.resolve();

    return authStateReady.then(() => {
        const userId = currentUser?.uid || "";
        if (homeRecommendationsPromise && homeRecommendationsUserId === userId) {
            return homeRecommendationsPromise;
        }

        homeRecommendationsUserId = userId;
        const requestVersion = ++homeRecommendationsRequestVersion;
        homeRecommendationsPromise = renderHomeRecommendations(userId, requestVersion).catch(error => {
            console.error("Could not render home recommendations:", error);
            const status = document.getElementById("homeRecommendationsStatus");
            const container = document.getElementById("homeRecommendationsMovies");
            const sectionElement = document.getElementById("homeRecommendationsSection");
            if (container && status) {
                renderRecommendationList(container, status, [], "Recommendations are not available right now.");
            } else if (sectionElement) {
                sectionElement.hidden = true;
            }
        });
        return homeRecommendationsPromise;
    });
}

async function loadMovieDetailRecommendations(movie) {
    const section = document.getElementById("movieRecommendationsSection");
    const status = document.getElementById("movieRecommendationsStatus");
    const container = document.getElementById("movieRecommendationsMovies");
    if (!section || !status || !container) return;

    section.hidden = false;
    status.className = "section-status is-loading";
    status.textContent = "Loading recommendations...";
    container.replaceChildren();

    try {
        const recommended = await fetchRecommendationsForMovie(movie.id);
        const unique = new Map();
        recommended.forEach(candidate => {
            if (String(candidate.id) !== String(movie.id) && isRecommendationMovie(candidate)) {
                unique.set(String(candidate.id), candidate);
            }
        });
        const rendered = renderRecommendationList(container, status, [...unique.values()].slice(0, 10), "No similar movies are available right now.");
        if (!rendered) section.hidden = true;
    } catch (error) {
        console.warn(`Could not load recommendations for movie ${movie.id}:`, error);
        section.hidden = true;
    }
}

function formatMovieRuntime(runtime) {
    const minutes = Number(runtime);
    if (!Number.isFinite(minutes) || minutes <= 0) return "Runtime unavailable";
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = Math.round(minutes % 60);
    return hours ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
}

function formatMovieReleaseDate(releaseDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(releaseDate || ""))) {
        return releaseDate || "Release date unavailable";
    }
    const date = new Date(`${releaseDate}T00:00:00`);
    return Number.isNaN(date.getTime())
        ? releaseDate
        : new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(date);
}

async function getTmdbMovieExtra(movieId, resource) {
    const safeMovieId = String(movieId || "").match(/^\d+$/)?.[0];
    if (!safeMovieId || !["credits", "videos"].includes(resource)) {
        throw new Error("A valid movie ID and TMDB movie resource are required.");
    }
    const params = new URLSearchParams({ api_key: API_KEY, language: "en-US" });
    const response = await fetch(`${API_URL}/movie/${safeMovieId}/${resource}?${params.toString()}`);
    if (!response.ok) {
        throw new Error(`TMDB ${resource} request failed with status ${response.status}.`);
    }
    return response.json();
}

function renderMovieCredits(credits) {
    const castSection = document.getElementById("movieCastSection");
    const castList = document.getElementById("movieCastList");
    const directorField = document.getElementById("movieDirectorField");
    const directorName = document.getElementById("movieDirector");
    if (!castSection || !castList || !directorField || !directorName) return;

    const cast = (Array.isArray(credits?.cast) ? credits.cast : [])
        .filter(person => person?.name && person?.character)
        .slice(0, 8);
    castList.replaceChildren();

    cast.forEach(person => {
        const card = document.createElement("article");
        const imageFrame = document.createElement("div");
        const name = document.createElement("h3");
        const character = document.createElement("p");

        card.className = "movie-cast-card";
        imageFrame.className = "movie-cast-image";
        name.textContent = person.name;
        character.textContent = person.character;

        if (person.profile_path) {
            const image = document.createElement("img");
            image.src = `https://image.tmdb.org/t/p/w185${person.profile_path}`;
            image.alt = `${person.name} as ${person.character}`;
            image.loading = "lazy";
            image.addEventListener("error", () => {
                imageFrame.replaceChildren(createCastPlaceholder(person.name));
            }, { once: true });
            imageFrame.appendChild(image);
        } else {
            imageFrame.appendChild(createCastPlaceholder(person.name));
        }

        card.append(imageFrame, name, character);
        castList.appendChild(card);
    });
    castSection.hidden = cast.length === 0;

    const director = (Array.isArray(credits?.crew) ? credits.crew : [])
        .find(person => person?.job === "Director" && person?.name);
    if (director) {
        directorName.textContent = director.name;
        directorField.hidden = false;
    } else {
        directorName.textContent = "";
        directorField.hidden = true;
    }
}

function createCastPlaceholder(name) {
    const placeholder = document.createElement("div");
    const initials = String(name || "?")
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(part => part.charAt(0))
        .join("")
        .toUpperCase();
    placeholder.className = "movie-cast-placeholder";
    placeholder.setAttribute("aria-label", `No profile image for ${name || "cast member"}`);
    placeholder.textContent = initials || "?";
    return placeholder;
}

function renderProductionCompanies(companies) {
    const section = document.getElementById("productionCompaniesSection");
    const list = document.getElementById("productionCompaniesList");
    if (!section || !list) return;

    const validCompanies = (Array.isArray(companies) ? companies : [])
        .filter(company => company?.name)
        .slice(0, 6);
    list.replaceChildren();

    validCompanies.forEach(company => {
        const item = document.createElement("div");
        const name = document.createElement("span");
        item.className = "production-company";
        name.className = "production-company-name";
        name.textContent = company.name;

        if (company.logo_path) {
            const logo = document.createElement("img");
            logo.src = `https://image.tmdb.org/t/p/w300${company.logo_path}`;
            logo.alt = `${company.name} logo`;
            logo.loading = "lazy";
            logo.addEventListener("error", () => {
                logo.remove();
                item.classList.add("has-no-logo");
            }, { once: true });
            item.appendChild(logo);
        } else {
            item.classList.add("has-no-logo");
        }

        item.appendChild(name);
        list.appendChild(item);
    });
    section.hidden = validCompanies.length === 0;
}

function getBestMovieTrailer(videos) {
    const candidates = (Array.isArray(videos) ? videos : [])
        .filter(video => video?.key
            && ["Trailer", "Teaser"].includes(video.type)
            && ["YouTube", "Vimeo"].includes(video.site));

    for (const type of ["Trailer", "Teaser"]) {
        for (const site of ["YouTube", "Vimeo"]) {
            const matches = candidates.filter(video => video.type === type && video.site === site);
            matches.sort((left, right) => {
                const officialScore = video => (video.official ? 2 : 0) + (/\bofficial\b/i.test(video.name || "") ? 1 : 0);
                return officialScore(right) - officialScore(left);
            });
            if (matches.length) return matches[0];
        }
    }
    return null;
}

function renderMovieTrailer(videos) {
    const section = document.getElementById("movieTrailerSection");
    const button = document.getElementById("movieTrailerButton");
    const dialog = document.getElementById("movieTrailerDialog");
    const frame = document.getElementById("movieTrailerFrame");
    const closeButton = document.getElementById("movieTrailerClose");
    const trailer = getBestMovieTrailer(videos);
    if (!section || !button || !dialog || !frame || !closeButton || !trailer) {
        if (section) section.hidden = true;
        return;
    }

    const trailerUrl = trailer.site === "YouTube"
        ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.key)}?autoplay=1&rel=0`
        : `https://player.vimeo.com/video/${encodeURIComponent(trailer.key)}?autoplay=1`;
    frame.title = trailer.name || `${trailer.type} for this movie`;
    section.hidden = false;

    button.addEventListener("click", () => {
        frame.src = trailerUrl;
        if (typeof dialog.showModal === "function") {
            dialog.showModal();
        } else {
            dialog.setAttribute("open", "");
        }
    });
    closeButton.addEventListener("click", () => {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
    });
    dialog.addEventListener("click", event => {
        if (event.target === dialog && typeof dialog.close === "function") dialog.close();
    });
    dialog.addEventListener("close", () => frame.removeAttribute("src"));
}

async function loadMovieCredits(movieId) {
    try {
        renderMovieCredits(await getTmdbMovieExtra(movieId, "credits"));
    } catch (error) {
        console.warn(`Could not load credits for movie ${movieId}:`, error);
        document.getElementById("movieCastSection")?.setAttribute("hidden", "");
        document.getElementById("movieDirectorField")?.setAttribute("hidden", "");
    }
}

async function loadMovieVideos(movieId) {
    try {
        const videos = await getTmdbMovieExtra(movieId, "videos");
        renderMovieTrailer(videos?.results);
    } catch (error) {
        console.warn(`Could not load videos for movie ${movieId}:`, error);
        document.getElementById("movieTrailerSection")?.setAttribute("hidden", "");
    }
}


// =========================
// GET TRENDING MOVIES
// =========================

async function getTrendingMovies() {

    try {

        const response = await fetch(
            `${API_URL}/trending/movie/week?api_key=${API_KEY}`
        );

        if (!response.ok) {
            throw new Error(`Trending movies request failed with status ${response.status}.`);
        }

        const data = await response.json();

        console.log("Trending Movies:", data);

        setMovieSectionReady(
            "trendingMovies",
            "trendingStatus",
            data.results,
            "No trending movies are available right now."
        );

    } catch (error) {

        console.error("Error getting trending movies:", error);
        setMovieSectionState(
            "trendingMovies",
            "trendingStatus",
            "error",
            "Trending movies could not load. Please try again later."
        );

    }

}


// =========================
// GET NEW RELEASES
// =========================

async function getNewMovies() {

    try {

        const response = await fetch(
            `${API_URL}/movie/upcoming?api_key=${API_KEY}&language=en-US&page=1`
        );

        if (!response.ok) {
            throw new Error(`New releases request failed with status ${response.status}.`);
        }

        const data = await response.json();

        console.log("New Releases:", data);

        setMovieSectionReady(
            "newMovies",
            "newStatus",
            data.results,
            "No new releases are available right now.",
            true
        );

    } catch (error) {

        console.error("Error getting new releases:", error);
        setMovieSectionState(
            "newMovies",
            "newStatus",
            "error",
            "New releases could not load. Please try again later."
        );

    }

}


// =========================
// GET POPULAR MOVIES
// =========================

async function getPopularMovies() {

    try {
        const movies = await fetchTmdbMovieList("movie/popular");

        setMovieSectionReady(
            "popularMovies",
            "popularStatus",
            movies,
            "No popular movies are available right now."
        );

    } catch (error) {

        console.error("Error getting popular movies:", error);
        setMovieSectionState(
            "popularMovies",
            "popularStatus",
            "error",
            "Popular movies could not load. Please try again later."
        );

    }

}


// =========================
// MOVIE DISCOVERY
// =========================

function updateDiscoveryUrl() {

    const params = new URLSearchParams(window.location.search);

    if (discoveryState.genreId) {
        params.set("genre", discoveryState.genreId);
    } else {
        params.delete("genre");
    }

    if (discoveryState.sortBy === DISCOVERY_DEFAULT_SORT) {
        params.delete("sort");
    } else {
        params.set("sort", discoveryState.sortBy);
    }

    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);

}

function setDiscoveryFilterState() {

    document.querySelectorAll(".discovery-filter").forEach(button => {
        const isActive = button.dataset.genreId === discoveryState.genreId;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", String(isActive));
    });

    const sortSelect = document.getElementById("discoverySort");

    if (sortSelect) {
        sortSelect.value = discoveryState.sortBy;
    }

}

function setDiscoveryLoadMoreState() {

    const loadMoreButton = document.getElementById("discoveryLoadMore");

    if (!loadMoreButton) {
        return;
    }

    const hasMore = discoveryState.page < discoveryState.totalPages;
    loadMoreButton.hidden = !hasMore;
    loadMoreButton.disabled = discoveryState.isLoading;
    loadMoreButton.textContent = discoveryState.isLoading
        ? "Loading movies..."
        : "Load More Movies";

}

function renderDiscoveryMovies() {

    const container = document.getElementById("discoveryMovies");

    if (!container) {
        return;
    }

    container.innerHTML = "";
    discoveryState.movies.forEach(movie => {
        container.appendChild(createMovieCard(movie, true));
    });

}

async function fetchDiscoveryMovies(page) {

    const discoverParams = new URLSearchParams({
        api_key: API_KEY,
        language: "en-US",
        page: String(page),
        sort_by: discoveryState.sortBy,
        include_adult: "false",
        include_video: "false"
    });

    if (discoveryState.genreId) {
        discoverParams.set("with_genres", discoveryState.genreId);
    }

    const response = await fetch(`${API_URL}/discover/movie?${discoverParams.toString()}`);

    if (!response.ok) {
        throw new Error(`Movie discovery request failed with status ${response.status}.`);
    }

    return response.json();

}

async function loadDiscoveryMovies({ reset = false } = {}) {

    if (discoveryState.isLoading && !reset) {
        return;
    }

    const status = document.getElementById("discoveryStatus");
    const requestVersion = reset ? ++discoveryState.requestVersion : discoveryState.requestVersion;
    const nextPage = reset ? 1 : discoveryState.page + 1;

    if (!reset && (discoveryState.page >= discoveryState.totalPages || !discoveryState.totalPages)) {
        return;
    }

    discoveryState.isLoading = true;
    setDiscoveryLoadMoreState();

    if (reset) {
        discoveryState.movies = [];
        discoveryState.page = 0;
        discoveryState.totalPages = 0;
        document.getElementById("discoveryMovies").innerHTML = "";
        status.className = "section-status is-loading";
        status.textContent = "Loading movies...";
    }

    try {
        const data = await fetchDiscoveryMovies(nextPage);

        if (requestVersion !== discoveryState.requestVersion) {
            return;
        }

        const existingIds = new Set(discoveryState.movies.map(movie => String(movie.id)));
        const newMovies = (data.results || []).filter(movie => !existingIds.has(String(movie.id)));

        discoveryState.movies = [...discoveryState.movies, ...newMovies];
        discoveryState.page = nextPage;
        discoveryState.totalPages = data.total_pages || nextPage;
        renderDiscoveryMovies();

        status.className = discoveryState.movies.length
            ? "section-status is-ready"
            : "section-status is-empty";
        status.textContent = discoveryState.movies.length ? "" : "No movies found.";
    } catch (error) {
        if (requestVersion === discoveryState.requestVersion) {
            console.error("Error discovering movies:", {
                genreId: discoveryState.genreId,
                sortBy: discoveryState.sortBy,
                page: nextPage,
                error
            });
            status.className = "section-status is-error";
            status.textContent = "Unable to load movies right now. Please try again.";
        }
    } finally {
        if (requestVersion === discoveryState.requestVersion) {
            discoveryState.isLoading = false;
            setDiscoveryLoadMoreState();
        }
    }

}

function setupMovieDiscovery() {

    const discoverySection = document.getElementById("discoverMovies");
    const filters = document.getElementById("discoveryFilters");
    const sortSelect = document.getElementById("discoverySort");
    const loadMoreButton = document.getElementById("discoveryLoadMore");

    if (!discoverySection || !filters || !sortSelect || !loadMoreButton) {
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const selectedGenre = filters.querySelector(`[data-genre-id="${params.get("genre") || ""}"]`);
    discoveryState.genreId = selectedGenre ? selectedGenre.dataset.genreId : "";
    discoveryState.sortBy = [...sortSelect.options].some(option => option.value === params.get("sort"))
        ? params.get("sort")
        : DISCOVERY_DEFAULT_SORT;
    setDiscoveryFilterState();

    filters.addEventListener("click", event => {
        const button = event.target.closest(".discovery-filter");

        if (!button || button.dataset.genreId === discoveryState.genreId) {
            return;
        }

        discoveryState.genreId = button.dataset.genreId;
        setDiscoveryFilterState();
        updateDiscoveryUrl();
        loadDiscoveryMovies({ reset: true });
    });

    sortSelect.addEventListener("change", () => {
        discoveryState.sortBy = sortSelect.value;
        updateDiscoveryUrl();
        loadDiscoveryMovies({ reset: true });
    });

    loadMoreButton.addEventListener("click", () => loadDiscoveryMovies());
    loadDiscoveryMovies({ reset: true });

}


// =========================
// DISPLAY MOVIES
// =========================

function createMovieCard(movie, showReleaseDate = false) {

        const movieCard = document.createElement("div");
    const rating = Number.isFinite(Number(movie.vote_average))
        ? Number(movie.vote_average).toFixed(1)
        : "N/A";
    const releaseDate = movie.release_date || "Release date unavailable";
        const poster = movie.poster_path
            ? `
                <div class="movie-poster">
                    <img src="${IMAGE_URL}${movie.poster_path}" alt="${movie.title}">
                </div>
            `
            : `
                <div class="movie-poster movie-poster-placeholder" role="img" aria-label="Poster unavailable">
                    No poster available
                </div>
            `;

        movieCard.classList.add("movie-card");
        movieCard.tabIndex = 0;
        movieCard.setAttribute("role", "link");


        movieCard.innerHTML = `

            ${poster}

            <h3>${movie.title}</h3>

            <div class="movie-card-meta">
                <span class="movie-rating"><span aria-hidden="true">★</span> ${rating}</span>
                ${showReleaseDate ? `<span class="movie-release">${releaseDate}</span>` : ""}
            </div>

        `;


        // Make movie clickable

        movieCard.addEventListener("click", () => {

            window.location.href = `movie.html?id=${movie.id}`;

        });

        movieCard.addEventListener("keydown", event => {

            if (event.target !== movieCard) {
                return;
            }

            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                movieCard.click();
            }

        });


        return movieCard;

}

function displayMovies(movies, containerId, showReleaseDate = false) {

    const container = document.getElementById(containerId);

    if (!container) {
        return;
    }

    container.innerHTML = "";

    movies.forEach(movie => {
        container.appendChild(createMovieCard(movie, showReleaseDate));
    });

}


// =========================
// WATCHLIST DISPLAY
// =========================

async function updateWatchlistButton(button, movieId) {

    if (!button) {
        return;
    }

    const isAdded = await isMovieInWatchlist(movieId);

    button.textContent = isAdded
        ? "\u2713 Remove from Watchlist"
        : "\u2764\uFE0F Add to Watchlist";

    button.classList.toggle("is-added", isAdded);
    button.setAttribute("aria-pressed", String(isAdded));

}

async function renderWatchlist() {

    const renderVersion = ++watchlistRenderVersion;

    const watchlistContainer = document.getElementById("watchlistMovies");
    const watchlistStatus = document.getElementById("watchlistStatus");

    // Only run on watchlist.html.
    if (!watchlistContainer || !watchlistStatus) {
        return;
    }

    watchlistContainer.innerHTML = "";
    watchlistStatus.textContent = "Loading your watchlist...";

    await authStateReady;

    if (!currentUser) {
        watchlistStatus.textContent = "Log in to view and manage your personal watchlist.";
        return;
    }

    let watchlist;

    try {
        watchlist = await getFirestoreWatchlist(currentUser);
    } catch (error) {
        console.error("Error loading the Firestore watchlist:", {
            code: error?.code || "unknown",
            message: error?.message || String(error),
            uid: currentUser.uid,
            path: `users/${currentUser.uid}/watchlist`,
            error
        });
        watchlistStatus.textContent = getFirestoreWatchlistErrorMessage(error);
        return;
    }

    if (renderVersion !== watchlistRenderVersion) {
        return;
    }

    watchlist = deduplicateWatchlist(watchlist);
    watchlistContainer.innerHTML = "";

    if (watchlist.length === 0) {
        watchlistStatus.textContent = "Your watchlist is empty.";
        return;
    }

    watchlistStatus.textContent = "";

    watchlist.forEach(movie => {

        const movieCard = createMovieCard(movie, true);
        const removeButton = document.createElement("button");

        removeButton.classList.add("watchlist-remove-button");
        removeButton.type = "button";
        removeButton.textContent = "Remove";

        removeButton.addEventListener("click", event => {

            event.stopPropagation();
            removeButton.disabled = true;
            removeMovieFromWatchlist(movie.id)
                .then(() => renderWatchlist())
                .catch(error => {
                    console.error("Error removing movie from the Firestore watchlist:", error);
                    removeButton.disabled = false;
                    watchlistStatus.textContent =
                        "We could not remove that movie. Please try again.";
                });

        });

        movieCard.appendChild(removeButton);
        watchlistContainer.appendChild(movieCard);

    });

}


// =========================
// DISPLAY SELECTED PLAYBACK SOURCES
// =========================

async function getLegalMovies() {

    const container = document.getElementById("legalMovies");

    // Only run on the homepage, where the selected-source section exists.
    if (!container) {
        return;
    }

    container.innerHTML = "";

    const movies = await Promise.all(
        movieLibrary.map(async legalMovie => {
            try {

                const movie = await getTmdbMovie(legalMovie.tmdbId);

                // Use the library ID for the link and TMDB data for the card.
                return {
                    ...movie,
                    id: legalMovie.tmdbId,
                    title: movie.title || legalMovie.title
                };

            } catch (error) {

                console.error(`Error getting legal movie ${legalMovie.tmdbId}:`, error);
                return null;

            }
        })
    );

    const availableMovies = movies.filter(Boolean);

    if (availableMovies.length === 0) {
        setMovieSectionState(
            "legalMovies",
            "legalStatus",
            "empty",
            "No selected playback sources are available right now."
        );
        return;
    }

    setMovieSectionReady(
        "legalMovies",
        "legalStatus",
        availableMovies,
        "No selected playback sources are available right now.",
        true
    );

}


// =========================
// MOVIE SEARCH
// =========================

async function searchMovies(query) {

    const searchParams = new URLSearchParams({
        api_key: API_KEY,
        language: "en-US",
        query,
        page: "1"
    });

    const response = await fetch(
        `${API_URL}/search/movie?${searchParams.toString()}`
    );

    if (!response.ok) {
        throw new Error("TMDB search request failed.");
    }

    const data = await response.json();
    return data.results || [];

}

function setupMovieSearch() {

    const searchForm = document.getElementById("movieSearchForm");
    const searchInput = document.getElementById("movieSearchInput");
    const searchButton = searchForm?.querySelector('button[type="submit"]');
    const resultsSection = document.getElementById("searchResultsSection");
    const resultsContainer = document.getElementById("searchResults");
    const searchStatus = document.getElementById("searchStatus");

    // Search exists only on the homepage.
    if (!searchForm || !searchInput || !searchButton || !resultsSection || !resultsContainer || !searchStatus) {
        return;
    }

    searchForm.addEventListener("submit", async event => {

        event.preventDefault();

        const query = searchInput.value.trim();

        resultsSection.hidden = false;
        resultsContainer.innerHTML = "";

        if (!query) {
            searchStatus.textContent = "Please enter a movie title.";
            searchInput.focus();
            return;
        }

        searchStatus.textContent = "Searching movies...";
        searchButton.disabled = true;

        try {

            const movies = await searchMovies(query);

            if (movies.length === 0) {
                searchStatus.textContent = "No movies found.";
                return;
            }

            searchStatus.textContent = `Search results for "${query}"`;
            displayMovies(movies, "searchResults", true);

        } catch (error) {

            console.error("Error searching movies:", error);
            searchStatus.textContent =
                "We could not search for movies right now. Please try again.";

        } finally {

            searchButton.disabled = false;

        }

    });

}

// =========================
// GET MOVIE DETAILS
// =========================

async function getMovieDetails() {

    const movieDetails = document.querySelector(".movie-details");
    const movieBackdrop = document.getElementById("movieBackdrop");
    const movieTitle = document.getElementById("movieTitle");
    const moviePoster = document.getElementById("moviePoster");
    const movieRating = document.getElementById("movieRating");
    const movieDate = document.getElementById("movieDate");
    const movieRuntime = document.getElementById("movieRuntime");
    const movieVoteCount = document.getElementById("movieVoteCount");
    const movieGenres = document.getElementById("movieGenres");
    const movieOverview = document.getElementById("movieOverview");
    const movieAvailability = document.getElementById("movieAvailability");
    const watchButton = document.getElementById("watchButton");
    const watchlistButton = document.querySelector(".movie-actions .watchlist-btn");
    const movieActionStatus = document.getElementById("movieActionStatus");
    const movieDetailsError = document.getElementById("movieDetailsError");
    const movieDetailsErrorMessage = document.getElementById("movieDetailsErrorMessage");

    // Only run on movie.html.
    if (!movieDetails || !movieTitle || !moviePoster || !movieRating || !movieDate || !movieGenres || !movieOverview) {
        return;
    }

    function showMovieDetailsError(message) {
        movieDetails.classList.remove("movie-details-loading");
        movieDetails.classList.add("has-error");
        movieDetailsError.hidden = false;
        movieDetailsErrorMessage.textContent = message;
    }

    const movieId = new URLSearchParams(window.location.search).get("id");

    if (!movieId) {
        showMovieDetailsError("No movie was selected. Return home to choose a movie.");
        return;
    }

    try {
        const movie = await getTmdbMovie(movieId);

        console.log("Movie Details:", movie);

        movieDetails.classList.remove("movie-details-loading");
        movieDetailsError.hidden = true;

        if (movieBackdrop && movie.backdrop_path) {
            movieBackdrop.style.backgroundImage =
                `url("${IMAGE_URL.replace("w500", "original")}${movie.backdrop_path}")`;
        }

        movieTitle.textContent = movie.title;

        if (movie.poster_path) {
            moviePoster.src = `${IMAGE_URL}${movie.poster_path}`;
        } else {
            moviePoster.removeAttribute("src");
        }

        moviePoster.alt = movie.title;
        const voteAverage = Number(movie.vote_average);
        movieRating.textContent = Number.isFinite(voteAverage)
            ? `★ ${voteAverage.toFixed(1)}`
            : "★ Rating unavailable";
        movieDate.textContent = formatMovieReleaseDate(movie.release_date);
        if (movieRuntime) movieRuntime.textContent = formatMovieRuntime(movie.runtime);
        const voteCount = Number(movie.vote_count);
        if (movieVoteCount) {
            movieVoteCount.hidden = !Number.isFinite(voteCount) || voteCount <= 0;
            movieVoteCount.textContent = movieVoteCount.hidden ? "" : `${voteCount.toLocaleString()} votes`;
        }
        movieGenres.replaceChildren();
        const genres = Array.isArray(movie.genres) ? movie.genres.filter(genre => genre?.name) : [];
        genres.forEach(genre => {
            const genreLabel = document.createElement("span");
            genreLabel.className = "movie-genre-chip";
            genreLabel.textContent = genre.name;
            movieGenres.appendChild(genreLabel);
        });
        movieGenres.hidden = genres.length === 0;
        movieOverview.textContent = movie.overview || "No overview is available for this movie.";
        document.title = `MovieFlix - ${movie.title}`;

        renderProductionCompanies(movie.production_companies);
        loadMovieCredits(movie.id);
        loadMovieVideos(movie.id);
        loadMovieDetailRecommendations(movie);

        if (watchButton) {
            watchButton.removeAttribute("href");
            watchButton.setAttribute("aria-disabled", "true");
            watchButton.classList.add("is-unavailable");
            watchButton.innerHTML = '<span aria-hidden="true">▶</span> Checking Availability';
            movieAvailability.textContent = "CHECKING PLAYBACK SOURCES";
            movieActionStatus.textContent = "Checking for a technically validated full-length source.";

            findPlayableArchiveSourceForMovie(movie).then(source => {
                if (source) {
                    const params = new URLSearchParams({ id: String(movie.id) });
                    if (!source.isExistingSource) {
                        params.set("iaId", source.archiveId || source.identifier);
                        params.set("iaFile", source.fileName);
                    }

                    watchButton.href = `watch.html?${params.toString()}`;
                    watchButton.removeAttribute("aria-disabled");
                    watchButton.classList.remove("is-unavailable");
                    watchButton.innerHTML = '<span aria-hidden="true">▶</span> Watch Now';
                    movieAvailability.textContent = source.rightsVerified
                        ? "EXISTING PLAYBACK SOURCE"
                        : "ARCHIVE SOURCE FOUND; RIGHTS UNVERIFIED";
                    movieActionStatus.textContent = source.rightsVerified
                        ? `Playback source: ${source.source}.`
                        : `Playback source: ${source.source}. Availability does not establish distribution rights.`;
                    return;
                }

                watchButton.removeAttribute("href");
                watchButton.setAttribute("aria-disabled", "true");
                watchButton.classList.add("is-unavailable");
                watchButton.innerHTML = '<span aria-hidden="true">▶</span> Full Movie Unavailable';
                movieAvailability.textContent = "MOVIE DETAILS";
                movieActionStatus.textContent = "No technically validated full-length playback source was found.";
            }).catch(error => {
                console.warn("Could not check playback availability:", error);
                watchButton.removeAttribute("href");
                watchButton.setAttribute("aria-disabled", "true");
                watchButton.classList.add("is-unavailable");
                watchButton.innerHTML = '<span aria-hidden="true">▶</span> Full Movie Unavailable';
                movieAvailability.textContent = "MOVIE DETAILS";
                movieActionStatus.textContent = "Playback availability could not be verified right now.";
            });
        }

        if (watchlistButton) {
            activeMovieId = movie.id;
            activeWatchlistButton = watchlistButton;
            watchlistButton.disabled = false;

            try {
                await updateWatchlistButton(watchlistButton, movie.id);
            } catch (error) {
                console.error("Error loading the movie watchlist state:", error);
                movieActionStatus.textContent = "Movie details loaded, but the watchlist state is unavailable.";
            }

            watchlistButton.addEventListener("click", async () => {
                watchlistButton.disabled = true;

                try {
                    if (await isMovieInWatchlist(movie.id)) {
                        await removeMovieFromWatchlist(movie.id);
                    } else {
                        await addMovieToWatchlist(movie);
                    }

                    await updateWatchlistButton(watchlistButton, movie.id);
                } catch (error) {
                    console.error("Error updating the watchlist:", error);
                    movieActionStatus.textContent = "Could not update your watchlist. Please try again.";
                } finally {
                    watchlistButton.disabled = false;
                }
            });
        }

        setupReviewForm(movie);
        await loadReviews(movie);
    } catch (error) {
        console.error("Error getting movie details:", error);
        showMovieDetailsError(
            error.message.includes("Could not load TMDB movie")
                ? "This movie could not be found on TMDB."
                : "Movie details could not load right now. Please try again later."
        );
    }

}


// =========================
// LOAD WATCH PAGE
// =========================

async function loadWatchPage() {
    const watchPage = document.querySelector(".watch-page");
    const videoContainer = document.getElementById("videoContainer");
    const moviePlayer = document.getElementById("moviePlayer");
    const movieSource = document.getElementById("movieSource");
    const watchTitle = document.getElementById("watchTitle");
    const watchDescription = document.getElementById("watchDescription");
    const watchStatus = document.getElementById("watchStatus");
    const watchSourceLabel = document.getElementById("watchSourceLabel");
    const watchAvailability = document.getElementById("watchAvailability");
    const watchInfo = document.querySelector(".watch-info");
    const watchBackLink = document.getElementById("watchBackLink");
    const watchRating = document.getElementById("watchRating");
    const watchDate = document.getElementById("watchDate");
    const videoStatus = document.getElementById("videoStatus");
    const watchUnavailable = document.getElementById("watchUnavailable");
    const watchUnavailableTitle = document.getElementById("watchUnavailableTitle");
    const watchUnavailableMessage = document.getElementById("watchUnavailableMessage");
    const unavailableDetailsLink = document.getElementById("unavailableDetailsLink");
    const watchError = document.getElementById("watchError");
    const watchErrorTitle = document.getElementById("watchErrorTitle");
    const watchErrorMessage = document.getElementById("watchErrorMessage");

    if (!watchPage || !videoContainer || !moviePlayer || !movieSource || !watchTitle || !watchDescription) return;

    function setWatchError(title, message) {
        watchPage.classList.remove("is-loading");
        watchPage.classList.add("has-error");
        videoContainer.hidden = true;
        watchInfo.hidden = true;
        watchError.hidden = false;
        watchErrorTitle.textContent = title;
        watchErrorMessage.textContent = message;
    }

    function showUnavailable(movie, message, heading = `${movie.title} is not currently playable.`) {
        watchPage.classList.remove("is-loading");
        watchPage.classList.add("is-unavailable");
        videoContainer.hidden = true;
        watchUnavailable.hidden = false;
        watchUnavailableTitle.textContent = heading;
        watchUnavailableMessage.textContent = message;
        unavailableDetailsLink.href = `movie.html?id=${movie.id}`;
        watchTitle.textContent = movie.title;
        watchDescription.textContent = movie.overview || "No overview is available for this movie.";
    }

    moviePlayer.addEventListener("error", () => {
        console.error("Video playback error:", {
            movieId: new URLSearchParams(window.location.search).get("id"),
            mediaError: moviePlayer.error
        });
        videoStatus.textContent = "This video could not be played right now. Please try again later.";
        watchStatus.textContent = "PLAYBACK ERROR";
        watchPage.classList.add("has-video-error");
    });

    moviePlayer.addEventListener("loadedmetadata", async () => {
        videoStatus.textContent = "Ready to watch";
        watchStatus.textContent = "NOW PLAYING";
        if (currentUser && currentHistoryMovie) {
            await restoreWatchHistoryProgress(currentHistoryMovie.id, moviePlayer.duration);
        }
    });

    moviePlayer.addEventListener("timeupdate", () => scheduleWatchHistorySave());
    moviePlayer.addEventListener("pause", () => scheduleWatchHistorySave({ force: true }));
    moviePlayer.addEventListener("ended", () => scheduleWatchHistorySave({ force: true, completed: true }));
    window.addEventListener("beforeunload", () => scheduleWatchHistorySave({ force: true }));

    const params = new URLSearchParams(window.location.search);
    const requestedArchiveItemId = params.get("iaId");
    const requestedArchiveFileName = params.get("iaFile");
    const movieId = params.get("id");
    if (!movieId) {
        setWatchError("No movie was selected.", "Return to the movie catalog and choose a movie to watch.");
        return;
    }
    if (watchBackLink) watchBackLink.href = `movie.html?id=${movieId}`;

    try {
        const movie = await getTmdbMovie(movieId);
        currentHistoryMovie = movie;
        watchTitle.textContent = movie.title;
        watchRating.textContent = `★ ${Number(movie.vote_average || 0).toFixed(1)}`;
        watchDate.textContent = movie.release_date || "Release date unavailable";
        watchDescription.textContent = movie.overview || "No overview is available for this movie.";
        document.title = `Watch ${movie.title} - MovieFlix`;

        let source = null;
        if (requestedArchiveItemId && requestedArchiveFileName) {
            const itemData = await getInternetArchiveItemMetadata(requestedArchiveItemId);
            const archiveMetadata = itemData.metadata || {};
            const archiveDocument = {
                identifier: requestedArchiveItemId,
                title: archiveMetadata.title,
                description: archiveMetadata.description,
                subject: archiveMetadata.subject,
                year: archiveMetadata.year,
                date: archiveMetadata.date
            };
            source = validateArchiveCandidate(movie, archiveDocument, itemData, requestedArchiveFileName);
        } else {
            source = await findPlayableArchiveSourceForMovie(movie);
        }

        if (source && (!requestedArchiveItemId || source.archiveId === requestedArchiveItemId)
            && (!requestedArchiveFileName || source.fileName === requestedArchiveFileName)) {
            movieSource.src = source.videoUrl;
            movieSource.type = source.type;
            watchStatus.textContent = source.rightsVerified
                ? "LOADING EXISTING PLAYBACK SOURCE"
                : "LOADING ARCHIVE SOURCE; RIGHTS UNVERIFIED";
            watchAvailability.textContent = source.rightsVerified
                ? "EXISTING PLAYBACK SOURCE AVAILABLE"
                : "ARCHIVE SOURCE FOUND; RIGHTS UNVERIFIED";
            watchSourceLabel.textContent = `Source: ${source.source}`;
            videoContainer.hidden = false;
            moviePlayer.load();
        } else {
            movieSource.removeAttribute("src");
            moviePlayer.load();
            showUnavailable(
                movie,
                "MovieFlix could not validate a matching full-length playback source. Internet Archive availability does not establish distribution rights."
            );
        }
    } catch (error) {
        console.error("Error loading watch page:", error);
        setWatchError(
            "Movie unavailable.",
            error.message.includes("Could not load TMDB movie")
                ? "This movie could not be found on TMDB."
                : "Movie information could not load right now. Please try again later."
        );
    }
}


// =========================
// START APPLICATION
// =========================

if (document.getElementById("trendingMovies")) {

    getTrendingMovies();
    getNewMovies();
    getPopularMovies();
    getLegalMovies();
    setupMovieDiscovery();
    loadHomeWatchHistory();
    loadHomeRecommendations();

}

setupMovieSearch();

renderWatchlist();

getMovieDetails();

loadWatchPage();
