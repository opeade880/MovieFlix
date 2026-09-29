const navbar = document.querySelector(".navbar");
const menuToggle = navbar?.querySelector(".menu-toggle");
const navigation = navbar?.querySelector("nav");
const mobileBreakpoint = 768;

function closeMobileNavigation() {
    if (!navbar || !menuToggle || !navigation) {
        return;
    }

    navbar.classList.remove("is-menu-open");
    menuToggle.setAttribute("aria-expanded", "false");
}

function isHomepage() {
    return window.location.pathname.endsWith("/index.html")
        || window.location.pathname.endsWith("/");
}

function focusSearchInput() {
    const searchInput = document.getElementById("movieSearchInput");

    if (searchInput) {
        searchInput.focus({ preventScroll: true });
    }
}

function scrollToNavigationTarget(targetId, shouldFocusSearch = false) {
    const target = document.getElementById(targetId);

    if (!target) {
        return;
    }

    window.requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", block: "start" });

        if (shouldFocusSearch) {
            window.setTimeout(focusSearchInput, 350);
        }
    });
}

function handleNavigationTarget(event) {
    const link = event.currentTarget;
    const targetId = link.dataset.navTarget;

    if (!targetId) {
        closeMobileNavigation();
        return;
    }

    closeMobileNavigation();

    if (isHomepage()) {
        event.preventDefault();
        const nextHash = `#${targetId}`;

        if (window.location.hash !== nextHash) {
            window.history.pushState({}, "", `${window.location.pathname}${window.location.search}${nextHash}`);
        }

        scrollToNavigationTarget(targetId, targetId === "movieSearch");
    }
}

function handleInitialHash() {
    const targetId = window.location.hash.slice(1);

    if (targetId !== "discoverMovies" && targetId !== "movieSearch") {
        return;
    }

    closeMobileNavigation();
    scrollToNavigationTarget(targetId, targetId === "movieSearch");
}

menuToggle?.addEventListener("click", () => {
    const isOpen = navbar.classList.toggle("is-menu-open");
    menuToggle.setAttribute("aria-expanded", String(isOpen));
});

navigation?.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", handleNavigationTarget);
});

document.addEventListener("click", event => {
    if (window.innerWidth > mobileBreakpoint || !navbar?.classList.contains("is-menu-open")) {
        return;
    }

    if (!navbar.contains(event.target)) {
        closeMobileNavigation();
    }
});

window.addEventListener("hashchange", handleInitialHash);
window.addEventListener("pageshow", handleInitialHash);
handleInitialHash();
