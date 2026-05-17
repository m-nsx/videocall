'use strict';

// Application 100% client-side : WebRTC via PeerJS (cloud public PeerServer)
// Objectif : appel vidéo 1v1, UI simple, robuste, et nettoyage propre.

(() => {
  // --- Raccourcis DOM ---
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const myPeerIdEl = document.getElementById('myPeerId');
  const copyIdBtn = document.getElementById('copyIdBtn');
  const remotePeerIdInput = document.getElementById('remotePeerId');
  const callBtn = document.getElementById('callBtn');

  const remoteVideo = document.getElementById('remoteVideo');
  const localVideo = document.getElementById('localVideo');
  const remotePlaceholder = document.getElementById('remotePlaceholder');
  const localPlaceholder = document.getElementById('localPlaceholder');

  const btnMic = document.getElementById('btnMic');
  const btnCam = document.getElementById('btnCam');
  const btnHangup = document.getElementById('btnHangup');
  const micLabel = document.getElementById('micLabel');
  const camLabel = document.getElementById('camLabel');

  const errorBox = document.getElementById('errorBox');
  const toast = document.getElementById('toast');

  // --- État applicatif ---
  /** @type {Peer|null} */
  let peer = null;

  /** @type {MediaStream|null} */
  let localStream = null;

  /** @type {MediaStream|null} */
  let remoteStream = null;

  /** @type {import('peerjs').MediaConnection|null|any} */
  let currentCall = null;

  let myPeerId = '';
  let isMicEnabled = true;
  let isCamEnabled = true;

  // Évite les doubles demandes getUserMedia (double-clic / spam bouton)
  let isRequestingMedia = false;

  let toastTimer = null;

  // --- Utilitaires UI ---
  function setBadge(kind) {
    statusBadge.classList.remove('badge--idle', 'badge--ready', 'badge--calling', 'badge--live', 'badge--error');

    switch (kind) {
      case 'ready':
        statusBadge.classList.add('badge--ready');
        break;
      case 'calling':
        statusBadge.classList.add('badge--calling');
        break;
      case 'live':
        statusBadge.classList.add('badge--live');
        break;
      case 'error':
        statusBadge.classList.add('badge--error');
        break;
      default:
        statusBadge.classList.add('badge--idle');
        break;
    }
  }

  function setStatus(kind, badgeText, detailText) {
    setBadge(kind);
    statusBadge.textContent = badgeText;
    statusText.textContent = detailText;
  }

  function showError(message) {
    errorBox.hidden = false;
    errorBox.textContent = message;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function showToast(message) {
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }

    toast.textContent = message;
    toast.classList.add('is-visible');

    toastTimer = window.setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 2600);
  }

  function safePlay(videoEl) {
    // Certains navigateurs peuvent bloquer l'autoplay. On tente un play(), sans casser l'app si ça échoue.
    const playPromise = videoEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        // L'utilisateur peut cliquer sur la vidéo pour lancer la lecture.
      });
    }
  }

  function attachStream(videoEl, stream) {
    videoEl.srcObject = stream;
    safePlay(videoEl);
  }

  function detachStream(videoEl) {
    videoEl.srcObject = null;
  }

  function stopStreamTracks(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // noop
      }
    }
  }

  function hasLiveTracks(stream) {
    return Boolean(stream && stream.getTracks().some((t) => t.readyState === 'live'));
  }

  function updateControlsUi() {
    const peerReady = Boolean(myPeerId);
    const hasMedia = hasLiveTracks(localStream);

    // Micro/Cam : accessibles dès que PeerJS est prêt.
    // Si aucun flux n'est encore actif, un clic déclenche la demande getUserMedia.
    btnMic.disabled = !peerReady || isRequestingMedia;
    btnCam.disabled = !peerReady || isRequestingMedia;

    // Raccrocher uniquement pendant un appel.
    btnHangup.disabled = !currentCall;

    // Appeler : uniquement si Peer ouvert + id distant renseigné + pas déjà en appel.
    const remoteId = remotePeerIdInput.value.trim();
    const canCall = peerReady && Boolean(remoteId) && !currentCall && !isRequestingMedia;
    callBtn.disabled = !canCall;

    // Libellés + état visuel
    if (!hasMedia) {
      micLabel.textContent = 'Activer micro';
      camLabel.textContent = 'Activer caméra';
      btnMic.classList.remove('is-off');
      btnCam.classList.remove('is-off');
      return;
    }

    micLabel.textContent = isMicEnabled ? 'Couper micro' : 'Activer micro';
    camLabel.textContent = isCamEnabled ? 'Couper caméra' : 'Activer caméra';

    btnMic.classList.toggle('is-off', !isMicEnabled);
    btnCam.classList.toggle('is-off', !isCamEnabled);
  }

  function setRemotePlaceholderVisible(visible) {
    remotePlaceholder.hidden = !visible;
  }

  function setLocalPlaceholderVisible(visible) {
    localPlaceholder.hidden = !visible;
  }

  // --- Média (caméra / micro) ---
  async function ensureLocalStream(
    { updateStatusDuringRequest = true, setReadyStatusOnSuccess = true } = {},
  ) {
    if (hasLiveTracks(localStream)) {
      return localStream;
    }

    if (isRequestingMedia) {
      // Une demande est déjà en cours : on attend que l'état se stabilise côté UI.
      throw new Error('Demande média déjà en cours');
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg = 'Votre navigateur ne supporte pas getUserMedia. Essayez un navigateur récent (Chrome/Edge/Firefox).';
      showError(msg);
      setStatus('error', 'Erreur', msg);
      throw new Error(msg);
    }

    clearError();

    isRequestingMedia = true;
    updateControlsUi();

    if (updateStatusDuringRequest) {
      setStatus('calling', 'Accès média…', 'Demande d’autorisation caméra/micro…');
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      localStream = stream;
      isMicEnabled = true;
      isCamEnabled = true;

      attachStream(localVideo, stream);
      setLocalPlaceholderVisible(false);

      // Par sécurité : local vidéo toujours muet (évite l'écho).
      localVideo.muted = true;

      updateControlsUi();

      // Si on n'est pas en appel, on affiche juste l'aperçu.
      if (setReadyStatusOnSuccess && !currentCall) {
        setStatus('ready', 'Prêt', 'Aperçu caméra actif. En attente…');
      }

      return stream;
    } catch (err) {
      const userMessage = mediaErrorToMessage(err);
      showError(userMessage);
      setStatus('error', 'Erreur média', userMessage);
      setLocalPlaceholderVisible(true);
      detachStream(localVideo);
      localStream = null;
      updateControlsUi();
      throw err;
    } finally {
      isRequestingMedia = false;
      updateControlsUi();
    }
  }

  function mediaErrorToMessage(err) {
    // Normalisation simple des erreurs getUserMedia.
    const name = err && err.name ? String(err.name) : '';

    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return 'Accès caméra/micro refusé. Autorisez les permissions du navigateur pour passer/recevoir un appel.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'Aucune caméra/micro détecté. Branchez un périphérique puis réessayez.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Impossible d’accéder à la caméra/micro (déjà utilisé par une autre appli ?).';
      case 'OverconstrainedError':
        return 'Contraintes vidéo non supportées. Essayez avec une autre caméra.';
      case 'SecurityError':
        return 'Accès média bloqué : utilisez HTTPS ou http://localhost (pas file://).';
      default:
        return 'Erreur lors de l’accès caméra/micro. Vérifiez vos permissions et réessayez.';
    }
  }

  function applyMediaTrackState() {
    if (!localStream) return;

    for (const audioTrack of localStream.getAudioTracks()) {
      audioTrack.enabled = isMicEnabled;
    }

    for (const videoTrack of localStream.getVideoTracks()) {
      videoTrack.enabled = isCamEnabled;
    }
  }

  // --- Gestion d’appel ---
  function bindCallHandlers(call) {
    // Flux distant
    call.on('stream', (stream) => {
      remoteStream = stream;
      attachStream(remoteVideo, stream);
      setRemotePlaceholderVisible(false);

      setStatus('live', 'Appel en cours', `Connecté à ${call.peer}`);
    });

    // Fin d'appel
    call.on('close', () => {
      endCall({ reason: 'remote-close', showToastMessage: 'Appel terminé.' });
    });

    call.on('error', (err) => {
      const msg = peerErrorToMessage(err);
      showError(msg);
      setStatus('error', 'Erreur', msg);
      endCall({ reason: 'call-error', showToastMessage: 'Erreur pendant l’appel.', keepStatus: true });
    });

    // Bonus robustesse : écouter l'état de la peerConnection si accessible.
    const pc = call && call.peerConnection;
    if (pc && typeof pc.addEventListener === 'function') {
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
          endCall({ reason: `pc-${pc.connectionState}`, showToastMessage: 'Connexion interrompue.' });
        }
      });

      pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
          endCall({ reason: `ice-${pc.iceConnectionState}`, showToastMessage: 'ICE interrompu.' });
        }
      });
    }

    updateControlsUi();
  }

  async function startOutboundCall() {
    const remoteId = remotePeerIdInput.value.trim();

    if (!remoteId) {
      showToast('Collez un ID à appeler.');
      return;
    }

    if (!myPeerId) {
      showToast('PeerJS n’est pas prêt (ID non généré).');
      return;
    }

    if (remoteId === myPeerId) {
      showToast('Vous ne pouvez pas vous appeler vous‑même.');
      return;
    }

    if (currentCall) {
      showToast('Déjà en appel. Raccrochez d’abord.');
      return;
    }

    setStatus('calling', 'Appel…', 'Activation caméra/micro…');

    let stream;
    try {
      stream = await ensureLocalStream({
        updateStatusDuringRequest: false,
        setReadyStatusOnSuccess: false,
      });
    } catch {
      // Erreur déjà affichée.
      return;
    }

    try {
      applyMediaTrackState();

      setStatus('calling', 'Appel sortant…', `Connexion à ${remoteId}…`);
      const call = peer.call(remoteId, stream);

      currentCall = call;
      bindCallHandlers(call);
      btnHangup.disabled = false;
      callBtn.disabled = true;

      // Si l'autre côté ne répond pas / est offline, PeerJS remontera une erreur.
    } catch (err) {
      const msg = peerErrorToMessage(err);
      showError(msg);
      setStatus('error', 'Erreur', msg);
      endCall({ reason: 'outbound-failed', showToastMessage: 'Impossible de démarrer l’appel.' });
    }
  }

  async function handleInboundCall(call) {
    // Si on est déjà en appel, on refuse proprement.
    if (currentCall) {
      try {
        call.close();
      } catch {
        // noop
      }
      showToast('Appel entrant refusé : déjà en appel.');
      return;
    }

    clearError();
    setStatus('calling', 'Appel entrant…', `Réponse automatique à ${call.peer}…`);

    let stream;
    try {
      // Sur certains navigateurs, getUserMedia peut être bloqué sans interaction.
      // On tente quand même afin de respecter la contrainte “répondre automatiquement”.
      stream = await ensureLocalStream({
        updateStatusDuringRequest: false,
        setReadyStatusOnSuccess: false,
      });
    } catch {
      showToast('Autorisation caméra/micro requise pour répondre.');
      try {
        call.close();
      } catch {
        // noop
      }
      setStatus('error', 'Réponse impossible', 'Caméra/micro non autorisés.');
      return;
    }

    try {
      applyMediaTrackState();
      currentCall = call;

      call.answer(stream);
      bindCallHandlers(call);

      setStatus('calling', 'Connexion…', 'Échange des flux WebRTC…');
      btnHangup.disabled = false;
      callBtn.disabled = true;
    } catch (err) {
      const msg = peerErrorToMessage(err);
      showError(msg);
      setStatus('error', 'Erreur', msg);
      endCall({ reason: 'inbound-answer-failed', showToastMessage: 'Impossible de répondre.' });
    }
  }

  function endCall({ reason, showToastMessage, keepStatus = false } = {}) {
    // Évite les appels multiples.
    const hadCall = Boolean(currentCall);

    // Fermer l'appel PeerJS
    if (currentCall) {
      try {
        currentCall.close();
      } catch {
        // noop
      }
    }

    currentCall = null;

    // Nettoyage des streams
    if (remoteStream) {
      stopStreamTracks(remoteStream);
      remoteStream = null;
    }

    // Pour respecter la contrainte "nettoyage des flux", on arrête aussi le stream local.
    // (Il sera redemandé automatiquement au prochain appel.)
    if (localStream) {
      stopStreamTracks(localStream);
      localStream = null;
    }

    detachStream(remoteVideo);
    detachStream(localVideo);

    setRemotePlaceholderVisible(true);
    setLocalPlaceholderVisible(true);

    isMicEnabled = true;
    isCamEnabled = true;

    if (hadCall) {
      if (showToastMessage) {
        showToast(showToastMessage);
      }

      // Par défaut on revient à l'état “En attente…”.
      // En cas d'erreur, certains handlers demandent de conserver le statut.
      if (!keepStatus) {
        setStatus('idle', 'Prêt', 'En attente…');
      }
    }

    // Réactive l'UI (boutons/inputs)
    updateControlsUi();

    // Petit log "raison" pour debug si besoin (sans polluer l'UI).
    // eslint-disable-next-line no-console
    if (reason) console.debug('[endCall]', reason);
  }

  // --- PeerJS : erreurs ---
  function peerErrorToMessage(err) {
    // PeerJS renvoie parfois un objet { type } ou Error.
    const type = err && (err.type || err.name) ? String(err.type || err.name) : '';

    switch (type) {
      case 'peer-unavailable':
        return 'Le correspondant est introuvable (ID incorrect ou hors ligne).';
      case 'network':
      case 'socket-error':
      case 'socket-closed':
        return 'Problème réseau avec le serveur PeerJS. Réessayez dans un instant.';
      case 'webrtc':
        return 'Erreur WebRTC : vérifiez vos permissions et votre connexion.';
      case 'browser-incompatible':
        return 'Navigateur incompatible avec WebRTC/PeerJS. Essayez Chrome/Edge/Firefox.';
      default:
        return 'Une erreur est survenue. Réessayez.';
    }
  }

  // --- Actions UI ---
  async function onToggleMic() {
    const hadMedia = hasLiveTracks(localStream);

    if (!hadMedia) {
      try {
        await ensureLocalStream({ updateStatusDuringRequest: true, setReadyStatusOnSuccess: true });
      } catch {
        return;
      }

      // Premier clic : on active simplement le flux (micro ON)
      isMicEnabled = true;
      applyMediaTrackState();
      updateControlsUi();
      showToast('Micro activé.');
      return;
    }

    // Ensuite : toggle ON/OFF
    isMicEnabled = !isMicEnabled;
    applyMediaTrackState();
    updateControlsUi();

    showToast(isMicEnabled ? 'Micro activé.' : 'Micro coupé.');
  }

  async function onToggleCam() {
    const hadMedia = hasLiveTracks(localStream);

    if (!hadMedia) {
      try {
        await ensureLocalStream({ updateStatusDuringRequest: true, setReadyStatusOnSuccess: true });
      } catch {
        return;
      }

      // Premier clic : on active simplement le flux (caméra ON)
      isCamEnabled = true;
      applyMediaTrackState();
      updateControlsUi();
      showToast('Caméra activée.');
      return;
    }

    // Ensuite : toggle ON/OFF
    isCamEnabled = !isCamEnabled;
    applyMediaTrackState();
    updateControlsUi();

    showToast(isCamEnabled ? 'Caméra activée.' : 'Caméra coupée.');
  }

  function onHangup() {
    if (!currentCall) return;
    endCall({ reason: 'hangup', showToastMessage: 'Vous avez raccroché.' });
  }

  async function copyMyId() {
    if (!myPeerId) return;

    try {
      await navigator.clipboard.writeText(myPeerId);
      showToast('ID copié dans le presse-papiers.');
    } catch {
      // Fallback : prompt simple
      window.prompt('Copiez cet ID :', myPeerId);
    }
  }

  // --- Initialisation ---
  function initPeer() {
    if (!window.Peer) {
      const msg = 'PeerJS n’a pas été chargé (CDN inaccessible ?).';
      showError(msg);
      setStatus('error', 'Erreur', msg);
      return;
    }

    setStatus('idle', 'Initialisation…', 'Connexion au cloud PeerJS…');

    // Cloud public PeerJS (aucun backend nécessaire)
    peer = new Peer(undefined, {
      debug: 2,
    });

    peer.on('open', (id) => {
      myPeerId = id;
      myPeerIdEl.textContent = id;

      copyIdBtn.disabled = false;

      setStatus('idle', 'Prêt', 'En attente…');
      updateControlsUi();
    });

    peer.on('call', (call) => {
      handleInboundCall(call);
    });

    peer.on('disconnected', () => {
      // Tentative de reconnexion (si possible)
      setStatus('calling', 'Reconnexion…', 'Connexion au cloud PeerJS perdue.');
      try {
        peer.reconnect();
      } catch {
        // noop
      }
    });

    peer.on('close', () => {
      setStatus('error', 'Fermé', 'Connexion PeerJS fermée. Rafraîchissez la page.');
      endCall({ reason: 'peer-close', keepStatus: true });
    });

    peer.on('error', (err) => {
      const msg = peerErrorToMessage(err);
      showError(msg);
      setStatus('error', 'Erreur', msg);

      // Si une erreur survient pendant un appel, on nettoie.
      if (currentCall) {
        endCall({ reason: 'peer-error', showToastMessage: 'Erreur : appel interrompu.', keepStatus: true });
      }
    });
  }

  function bindUiEvents() {
    copyIdBtn.addEventListener('click', copyMyId);

    callBtn.addEventListener('click', startOutboundCall);

    remotePeerIdInput.addEventListener('input', () => {
      updateControlsUi();
    });

    remotePeerIdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        startOutboundCall();
      }
    });

    btnMic.addEventListener('click', onToggleMic);
    btnCam.addEventListener('click', onToggleCam);
    btnHangup.addEventListener('click', onHangup);

    // Nettoyage en quittant la page
    window.addEventListener('pagehide', () => {
      try {
        endCall({ reason: 'pagehide' });
      } catch {
        // noop
      }

      try {
        if (peer && !peer.destroyed) peer.destroy();
      } catch {
        // noop
      }
    });
  }

  function initialUiState() {
    // Placeholders visibles au début
    setRemotePlaceholderVisible(true);
    setLocalPlaceholderVisible(true);

    // Contrôles : désactivés tant qu'on n'a pas de stream local
    btnMic.disabled = true;
    btnCam.disabled = true;
    btnHangup.disabled = true;

    callBtn.disabled = true;
    copyIdBtn.disabled = true;

    micLabel.textContent = 'Micro';
    camLabel.textContent = 'Caméra';
  }

  // Démarrage
  initialUiState();
  bindUiEvents();
  initPeer();
})();
