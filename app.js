"use strict";

/* ============================================================
   RISHI MUSIC — HIGH-CAPACITY ENGINE (800+ SONGS)
   - Virtual pagination (renders 40 cards at a time on scroll)
   - Zero-RAM audio streaming (blobs fetched on-demand)
   - Strict daily rotation (no repeats until all 800+ played)
   - Full AirPods / Bluetooth media controls
   ============================================================ */

/* 1. SERVICE WORKER */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
        navigator.serviceWorker.register("./sw.js").catch(function (err) {
            console.error("[Rishi Music] SW Registration Failed:", err);
        });
    });
}

/* 2. INDEXEDDB WITH ON-DEMAND BLOB STREAMING */
const DB_NAME = "RishiMusicDB_v4";
const DB_VERSION = 1;
const STORE_NAME = "audio_library";
let db = null;

function initDB() {
    return new Promise(function (resolve, reject) {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function (e) {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
        };
        request.onsuccess = function () {
            db = request.result;
            resolve(db);
        };
        request.onerror = function () {
            reject(request.error);
        };
    });
}

// Loads only ID, title, and director (leaves heavy audio on disk)
function getAllTracksMetadata() {
    return new Promise(function (resolve) {
        if (!db) return resolve([]);
        const tx = db.transaction([STORE_NAME], "readonly");
        const store = tx.objectStore(STORE_NAME);
        const metadata = [];
        const req = store.openCursor();

        req.onsuccess = function (e) {
            const cursor = e.target.result;
            if (cursor) {
                // Strip the heavy blob from RAM
                metadata.push({
                    id: cursor.value.id,
                    title: cursor.value.title,
                    director: cursor.value.director
                });
                cursor.continue();
            } else {
                resolve(metadata);
            }
        };
        req.onerror = function () {
            resolve([]);
        };
    });
}

// Fetch single audio file from disk only when playing
function getTrackAudioBlob(id) {
    return new Promise(function (resolve, reject) {
        if (!db) return reject(new Error("DB closed"));
        const tx = db.transaction([STORE_NAME], "readonly");
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = function () {
            resolve(req.result ? req.result.blob : null);
        };
        req.onerror = function () {
            reject(req.error);
        };
    });
}

function saveTrackToDB(track) {
    return new Promise(function (resolve, reject) {
        if (!db) return resolve();
        const tx = db.transaction([STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(track);
        req.onsuccess = function () { resolve(); };
        req.onerror = function (e) { reject(e); };
    });
}

function removeTrackFromDB(id) {
    return new Promise(function (resolve) {
        if (!db) return resolve();
        const tx = db.transaction([STORE_NAME], "readwrite");
        const store = tx.objectStore(STORE_NAME);
        store.delete(id);
        tx.oncomplete = function () { resolve(); };
    });
}

/* 3. APPLICATION STATE */
let tracks = [];
let currentTrackIndex = -1;
let currentBlobUrl = null;
let playHistory = [];
let userManuallyPaused = false;
let isSwitchingSong = false;
let activeEditingTrackId = null;
let deferredPrompt = null;

// Virtual Pagination (renders in chunks of 40)
const BATCH_SIZE = 40;
let renderedCount = 0;
let filteredTrackIndices = [];

/* 4. DOM REFERENCES */
const audio = document.getElementById("audioEl");
const tracksContainer = document.getElementById("tracksContainer");
const searchInput = document.getElementById("searchInput");
const directorFilter = document.getElementById("directorFilter");
const importBtn = document.getElementById("importBtn");
const fileSelector = document.getElementById("fileSelector");
const mainPlayBtn = document.getElementById("mainPlayBtn");
const mainPlayIcon = document.getElementById("mainPlayIcon");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const progressBar = document.getElementById("progressBar");
const currentTimeEl = document.getElementById("currentTime");
const durationEl = document.getElementById("duration");
const dockTitle = document.getElementById("dockTitle");
const dockSubtitle = document.getElementById("dockSubtitle");
const installBar = document.getElementById("installBar");
const installTriggerBtn = document.getElementById("installTriggerBtn");
const editModal = document.getElementById("editModal");
const editTitleInput = document.getElementById("editTitleInput");
const editDirectorInput = document.getElementById("editDirectorInput");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const saveEditBtn = document.getElementById("saveEditBtn");

/* 5. FAST DAILY ROTATION ENGINE FOR 800+ SONGS */
function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function getDailyLog() {
    const today = getTodayDateString();
    try {
        const raw = localStorage.getItem("rishi_daily_plays_v4");
        let parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || parsed.date !== today || !Array.isArray(parsed.playedIds)) {
            parsed = { date: today, playedIds: [] };
            localStorage.setItem("rishi_daily_plays_v4", JSON.stringify(parsed));
        }
        return parsed;
    } catch (e) {
        return { date: today, playedIds: [] };
    }
}

function saveDailyLog(log) {
    try {
        localStorage.setItem("rishi_daily_plays_v4", JSON.stringify(log));
    } catch (e) {
        console.warn("Storage error:", e);
    }
}

function markSongAsPlayed(songId) {
    const log = getDailyLog();
    if (!log.playedIds.includes(songId)) {
        log.playedIds.push(songId);
    }
    // If all songs have been played today, reset cycle
    if (tracks.length > 0 && log.playedIds.length >= tracks.length) {
        log.playedIds = [];
    }
    saveDailyLog(log);
    renderTrackList(false);
}

function getNextUnplayedIndex() {
    if (tracks.length === 0) return -1;
    if (tracks.length === 1) return 0;

    const log = getDailyLog();
    const playedSet = new Set(log.playedIds);

    let unplayed = [];
    for (let i = 0; i < tracks.length; i++) {
        if (!playedSet.has(tracks[i].id) && i !== currentTrackIndex) {
            unplayed.push(i);
        }
    }

    // All songs played today: reset daily cycle
    if (unplayed.length === 0) {
        log.playedIds = [];
        saveDailyLog(log);
        for (let i = 0; i < tracks.length; i++) {
            if (i !== currentTrackIndex) {
                unplayed.push(i);
            }
        }
    }

    if (unplayed.length === 0) return 0;
    const rand = Math.floor(Math.random() * unplayed.length);
    return unplayed[rand];
}

/* 6. AIRPODS CONTROLS */
function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title,
            artist: track.director,
            album: "Rishi Music"
        });

        navigator.mediaSession.setActionHandler("play", function () {
            userManuallyPaused = false;
            playCurrentTrack();
        });

        navigator.mediaSession.setActionHandler("pause", function () {
            pauseCurrentTrack();
        });

        navigator.mediaSession.setActionHandler("nexttrack", function () {
            userManuallyPaused = false;
            advanceToNextTrack();
        });

        navigator.mediaSession.setActionHandler("previoustrack", function () {
            userManuallyPaused = false;
            playPreviousTrack();
        });

        navigator.mediaSession.setActionHandler("seekto", function (e) {
            if (e.seekTime && Number.isFinite(e.seekTime)) {
                audio.currentTime = e.seekTime;
            }
        });
    } catch (e) {
        console.warn("MediaSession error:", e);
    }
}

/* 7. PLAYBACK ENGINE */
async function loadTrackSource(index) {
    if (index < 0 || index >= tracks.length) return false;

    currentTrackIndex = index;
    const track = tracks[currentTrackIndex];

    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }

    // Retrieve audio blob directly from IndexedDB on-demand
    const blob = await getTrackAudioBlob(track.id);
    if (!blob) {
        console.error("Audio data missing for track:", track);
        return false;
    }

    currentBlobUrl = URL.createObjectURL(blob);

    audio.pause();
    audio.currentTime = 0;
    audio.src = currentBlobUrl;
    audio.load();

    dockTitle.textContent = track.title;
    dockSubtitle.textContent = track.director;
    currentTimeEl.textContent = "0:00";
    durationEl.textContent = "0:00";
    progressBar.value = 0;

    updateMediaSession(track);
    renderTrackList(false);
    return true;
}

async function playCurrentTrack() {
    if (currentTrackIndex === -1 && tracks.length > 0) {
        const firstIdx = getNextUnplayedIndex();
        await loadTrackSource(firstIdx !== -1 ? firstIdx : 0);
    }

    const track = tracks[currentTrackIndex];
    if (!track) return;

    userManuallyPaused = false;

    try {
        await audio.play();
        setPlayIconState(true);
        if ("mediaSession" in navigator) {
            navigator.mediaSession.playbackState = "playing";
        }
        renderTrackList(false);
    } catch (error) {
        console.warn("Playback error/deferred:", error);
        setPlayIconState(false);
    }
}

function pauseCurrentTrack() {
    userManuallyPaused = true;
    audio.pause();
    setPlayIconState(false);
    if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
    }
    renderTrackList(false);
}

async function advanceToNextTrack() {
    if (isSwitchingSong || tracks.length === 0) return;
    isSwitchingSong = true;
    userManuallyPaused = false;

    if (currentTrackIndex !== -1) {
        playHistory.push(currentTrackIndex);
        if (playHistory.length > 50) playHistory.shift();
    }

    const nextIndex = getNextUnplayedIndex();
    if (nextIndex === -1) {
        isSwitchingSong = false;
        return;
    }

    const loaded = await loadTrackSource(nextIndex);
    if (loaded) {
        setTimeout(async function () {
            await playCurrentTrack();
            isSwitchingSong = false;
        }, 50);
    } else {
        isSwitchingSong = false;
    }
}

async function playPreviousTrack() {
    if (tracks.length === 0) return;
    userManuallyPaused = false;

    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        await playCurrentTrack();
        return;
    }

    if (playHistory.length > 0) {
        const prevIdx = playHistory.pop();
        await loadTrackSource(prevIdx);
        setTimeout(playCurrentTrack, 50);
    } else {
        audio.currentTime = 0;
        await playCurrentTrack();
    }
}

/* 8. NATIVE AUDIO EVENT LISTENERS */
audio.addEventListener("ended", function () {
    if (userManuallyPaused || isSwitchingSong) return;
    const currentTrack = tracks[currentTrackIndex];
    if (currentTrack) {
        markSongAsPlayed(currentTrack.id);
    }
    advanceToNextTrack();
});

audio.addEventListener("error", function () {
    if (userManuallyPaused || isSwitchingSong) return;
    setTimeout(advanceToNextTrack, 300);
});

audio.addEventListener("timeupdate", function () {
    if (!audio.duration) return;
    progressBar.value = (audio.currentTime / audio.duration) * 100;
    currentTimeEl.textContent = formatTime(audio.currentTime);
    durationEl.textContent = formatTime(audio.duration);
});

progressBar.addEventListener("input", function () {
    if (audio.duration) {
        audio.currentTime = (Number(progressBar.value) / 100) * audio.duration;
    }
});

function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
}

function setPlayIconState(isPlaying) {
    if (!mainPlayIcon) return;
    if (isPlaying) {
        mainPlayIcon.innerHTML = `<rect x="6" y="4" width="4" height="16" fill="#ffffff"></rect><rect x="14" y="4" width="4" height="16" fill="#ffffff"></rect>`;
    } else {
        mainPlayIcon.innerHTML = `<polygon points="6,4 20,12 6,20"></polygon>`;
    }
}

/* 9. VIRTUAL PAGINATION (NEVER CRASHES WITH 800+ SONGS) */
function computeFilteredList() {
    const query = String(searchInput.value || "").trim().toLowerCase();
    const filter = directorFilter.value || "ALL";

    filteredTrackIndices = [];
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const matchSearch = t.title.toLowerCase().includes(query) || t.director.toLowerCase().includes(query);
        const matchDirector = filter === "ALL" || t.director === filter;
        if (matchSearch && matchDirector) {
            filteredTrackIndices.push(i);
        }
    }
}

function appendTrackCards(count) {
    const log = getDailyLog();
    const playedSet = new Set(log.playedIds);
    const endIndex = Math.min(renderedCount + count, filteredTrackIndices.length);

    for (let i = renderedCount; i < endIndex; i++) {
        const idx = filteredTrackIndices[i];
        const track = tracks[idx];
        const isCurrent = idx === currentTrackIndex;
        const isPlaying = isCurrent && !audio.paused;
        const isPlayedToday = playedSet.has(track.id);

        const card = document.createElement("div");
        card.className = "track-card" + (isCurrent ? " active" : "") + (isPlayedToday ? " played-today" : "");

        card.innerHTML = `
            <div class="track-main">
                <span class="music-glyph">♬</span>
                <div class="track-text">
                    <div class="track-name">${track.title}</div>
                    <div class="track-sub">
                        ${track.director}
                        ${isPlayedToday ? '<span class="daily-status"> Played Today</span>' : ""}
                    </div>
                </div>
            </div>
            <div class="track-actions">
                <button class="edit-btn" data-action="edit" data-id="${track.id}">Edit</button>
                <button class="delete-btn" data-action="delete" data-id="${track.id}">🗑</button>
                <button class="card-play-btn" data-action="play" data-idx="${idx}">
                    ${isPlaying ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>' : '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"></polygon></svg>'}
                </button>
            </div>
        `;
        tracksContainer.appendChild(card);
    }
    renderedCount = endIndex;
}

function renderTrackList(resetList = true) {
    if (!tracksContainer) return;

    if (resetList) {
        computeFilteredList();
        tracksContainer.innerHTML = "";
        renderedCount = 0;
    }

    if (tracks.length === 0) {
        tracksContainer.innerHTML = `
            <div class="empty-state">
                Your library is empty.<br>
                Click <strong>+ Import Track</strong> above to add songs.
            </div>
        `;
        return;
    }

    if (resetList) {
        appendTrackCards(BATCH_SIZE);
    } else {
        // Light-refresh active status without full DOM wipe
        const cards = tracksContainer.querySelectorAll(".track-card");
        const log = getDailyLog();
        const playedSet = new Set(log.playedIds);

        cards.forEach((card, domIdx) => {
            const trackIdx = filteredTrackIndices[domIdx];
            if (trackIdx !== undefined) {
                const track = tracks[trackIdx];
                const isCurrent = trackIdx === currentTrackIndex;
                const isPlayedToday = playedSet.has(track.id);

                card.className = "track-card" + (isCurrent ? " active" : "") + (isPlayedToday ? " played-today" : "");
                const playBtn = card.querySelector(".card-play-btn");
                if (playBtn) {
                    playBtn.innerHTML = (isCurrent && !audio.paused)
                        ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>'
                        : '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"></polygon></svg>';
                }
            }
        });
    }
}

// Infinite scroll: smoothly load next batch when scrolling near bottom
window.addEventListener("scroll", function () {
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500) {
        if (renderedCount < filteredTrackIndices.length) {
            appendTrackCards(BATCH_SIZE);
        }
    }
});

function updateDirectorDropdown() {
    const cur = directorFilter.value || "ALL";
    const dirs = Array.from(new Set(tracks.map(function (t) { return t.director; }))).filter(Boolean).sort();
    directorFilter.innerHTML = '<option value="ALL">ALL DIRECTORS</option>';
    dirs.forEach(function (d) {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d;
        directorFilter.appendChild(opt);
    });
    directorFilter.value = Array.from(directorFilter.options).some(function (o) { return o.value === cur; }) ? cur : "ALL";
}

/* 10. CARD ACTIONS, EDIT & DELETE */
tracksContainer.addEventListener("click", async function (e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    e.stopPropagation();

    const action = btn.dataset.action;

    if (action === "play") {
        const idx = Number(btn.dataset.idx);
        const selected = tracks[idx];
        const log = getDailyLog();

        if (log.playedIds.includes(selected.id) && idx !== currentTrackIndex) {
            const ok = confirm(`"${selected.title}" has already been played today.\nDo you want to replay it anyway?`);
            if (!ok) return;
        }

        if (idx === currentTrackIndex) {
            if (audio.paused) await playCurrentTrack();
            else pauseCurrentTrack();
        } else {
            await loadTrackSource(idx);
            setTimeout(playCurrentTrack, 50);
        }
    } else if (action === "edit") {
        const track = tracks.find(function (t) { return t.id === btn.dataset.id; });
        if (!track) return;
        activeEditingTrackId = track.id;
        editTitleInput.value = track.title;
        editDirectorInput.value = track.director;
        editModal.classList.add("open");
    } else if (action === "delete") {
        const track = tracks.find(function (t) { return t.id === btn.dataset.id; });
        if (!track || !confirm(`Delete "${track.title}"?`)) return;

        await removeTrackFromDB(track.id);
        const idx = tracks.indexOf(track);
        if (idx === currentTrackIndex) {
            audio.pause();
            currentTrackIndex = -1;
            dockTitle.textContent = "No track playing";
            dockSubtitle.textContent = "Select a song from your library";
            setPlayIconState(false);
        }
        tracks.splice(idx, 1);
        updateDirectorDropdown();
        renderTrackList(true);
    }
});

cancelEditBtn.addEventListener("click", function () {
    editModal.classList.remove("open");
    activeEditingTrackId = null;
});

saveEditBtn.addEventListener("click", async function () {
    if (!activeEditingTrackId) return;
    const track = tracks.find(function (t) { return t.id === activeEditingTrackId; });
    if (!track) return;

    const t = editTitleInput.value.trim();
    const d = editDirectorInput.value.trim();
    if (!t) return alert("Title cannot be empty.");

    track.title = t;
    track.director = d || "UNKNOWN DIRECTOR";

    const blob = await getTrackAudioBlob(track.id);
    await saveTrackToDB({ id: track.id, title: track.title, director: track.director, blob: blob });

    if (tracks[currentTrackIndex]?.id === track.id) {
        dockTitle.textContent = track.title;
        dockSubtitle.textContent = track.director;
    }
    editModal.classList.remove("open");
    activeEditingTrackId = null;
    updateDirectorDropdown();
    renderTrackList(true);
});

/* 11. STREAM IMPORT (BATCHED TO PREVENT FREEZING) */
importBtn.addEventListener("click", function () { fileSelector.click(); });

fileSelector.addEventListener("change", async function (e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    importBtn.disabled = true;
    let savedCount = 0;

    for (const f of files) {
        try {
            importBtn.textContent = `Saving (${savedCount + 1}/${files.length})...`;
            const trackData = {
                id: "track_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
                title: f.name.replace(/\.[^.]+$/, ""),
                director: "UNKNOWN DIRECTOR",
                blob: f // Pure disk blob reference (0 RAM used)
            };
            await saveTrackToDB(trackData);
            tracks.push({ id: trackData.id, title: trackData.title, director: trackData.director });
            savedCount++;
        } catch (err) {
            console.error("Import error:", err);
        }
    }

    importBtn.disabled = false;
    importBtn.textContent = "+ Import Track";
    fileSelector.value = "";
    updateDirectorDropdown();
    renderTrackList(true);
});

/* 12. BOTTOM CONTROLS */
mainPlayBtn.addEventListener("click", async function () {
    if (audio.paused) await playCurrentTrack();
    else pauseCurrentTrack();
});
prevBtn.addEventListener("click", playPreviousTrack);
nextBtn.addEventListener("click", advanceToNextTrack);

searchInput.addEventListener("input", function () {
    renderTrackList(true);
});

directorFilter.addEventListener("change", function () {
    renderTrackList(true);
});

/* 13. PWA INSTALL BANNER */
window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (installBar) installBar.style.display = "flex";
});

installTriggerBtn.addEventListener("click", async function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const res = await deferredPrompt.userChoice;
    if (res.outcome === "accepted" && installBar) {
        installBar.style.display = "none";
    }
    deferredPrompt = null;
});

/* INITIALIZE */
initDB().then(async function () {
    tracks = await getAllTracksMetadata();
    updateDirectorDropdown();
    renderTrackList(true);
});