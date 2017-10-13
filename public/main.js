const useTrickleICE = false;

let localVideo = document.getElementById('local_video');
let remoteContainer = document.getElementById('remote_container');
let stateSpan = document.getElementById('state_span');
let localStream = null;
let peerConnection = null;

// *** 기본설정 ***
// 웹브라우저별로 WebRTC getUserMedia API 호출
navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;

RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;

RTCSessionDescription = window.RTCSessionDescription || window.webkitRTCSessionDescription || window.mozRTCSessionDescription;

// Chrome 브라우저의 경우, PlanB를 사용해야 하므로 체크박스 표시
if (window.window.webkitRTCPeerConnection) {
    document.getElementById('plan_b_check').checked = true;
}

// *** 웹소켓 ***
/*
let ws = new WebSocket('ws://localhost:3001/');
*/
let ws = new WebSocket('wss://' + window.location.hostname + ':' + window.location.port + '/');
console.log('웹소켓 url은 ' + 'wss://' + window.location.hostname + ':' + window.location.port + '/');

ws.onopen = function (event) {
    console.log('ws open()');
};

ws.onerror = function (error) {
    console.error('ws onerror(), ERROR: ' + error);
};

// 상대방이 들어오는 것을 감지하기 위한 코드
ws.onmessage = function (p1) {
    console.log('ws onmessage() DATA: ' + p1.data);

    let message = JSON.parse(p1.data);

    if (message.type === 'offer') {
        console.log('오퍼 받음...');

        let offer = new RTCSessionDescription(message);
        setOffer(offer);
    } else if (message.type === 'answer') {
        console.log('응답 받음...');
        console.warn('NOT USED');
    }
};

function getUsePlanB() {
    let checkbox = document.getElementById('plan_b_check');
    return (checkbox.checked === true);
}


// *** 미디어 핸들링 ***
// 로컬 비디오 스타트
function startVideo() {
    getDeviceStream({
        audio: true,
        video: true
    })
        .then( function (stream) {
            // Chrome 브라우저에서는 stream을 바로 video src로 사용할 수 없다
            localStream = stream;
            logStream('localstream', stream);
            playVideo(localVideo, stream);

            updateButtons();
        })
        .catch( function (error) {
            console.error('getUserMedia ERROR: ' + error);
            return;
        });
}

// 로컬 비디오 정지
function stopVideo() {
    pauseVideo(localVideo);
    stopLocalStream(localStream);
    localStream = null;

    updateButtons();
}

// 로컬 스트림 정지
function stopLocalStream(stream) {
   let tracks = stream.getTracks();

   if (! tracks) {
       console.warn('NO tracks');
       return;
   }

   for (let t of tracks){
       t.stop();
   }
}

// 브라우저로부터 스트림 따옴
function getDeviceStream(option) {
    if('getUserMedia' in navigator.mediaDevices) {
        console.log('navigator.mediaDevices.getUserMedia');
        return navigator.mediaDevices.getUserMedia(option);
    } else {
        console.log('navigator.getUserMedia를 Promise로 감쌈');
        return new Promise(function (resolve, reject) {
            navigator.getUserMedia(
                option,
                resolve,
                reject
            );
        });
    }
}

// 비디오 재생
function playVideo(element, stream) {
    if('srcObject' in element) {
        element.srcObject = stream;
    } else {
        element.src = window.URL.createObjectURL(stream);
    }

    element.play();
    element.volume = 0;
}

// 비디오 멈춤
function pauseVideo(element) {
    element.pause();

    if('srcObject' in element) {
        element.srcObject = null;
    } else {
        if (element.src && (element.src !== '')) {
            window.URL.revokeObjectURL(element.src);
        }

        element.src = '';
    }
}


// *** 시그널링 ***
function sendSdp(sessionDescription) {
    console.log('*** SDP 보냄 ***');

    const jsonSDP = sessionDescription.toJSON();
    jsonSDP.planb = getUsePlanB();
    console.log('보내는 SDP: ' + jsonSDP);

    sendJson(jsonSDP);
}

function sendJson(json) {
    // 웹소켓을 통해 전송
    const str = JSON.stringify(json);
    ws.send(str);
}

// *** 커넥션 핸들링 ***
function prepareNewConnection() {
    // ICE Server는 Google의 Public STUN Server를 사용할 수도 있음
    // 예시) { 'iceServers': [{'url': 'stun:stun.l.google.com:19302'}] };
    let pc_config = { 'iceServers': [] };
    let peer = new RTCPeerConnection(pc_config);

    // 리모트 스트림 받아옴
    if ('ontrack' in peer) {
        peer.ontrack = function (event) {
            console.log('*** peer.ontrack() ***');

            let stream = event.streams[0];
            logStream('remotestream of ontrack()', stream);

            if ((stream.getVideoTracks().length > 0) && (stream.getAudioTracks().length > 0)) {
                addRemoteVideo(stream.id, stream);
            }
        };
    } else {
        peer.onaddstream = function (event) {
            console.log('*** peer.onaddstream() ***');

            let stream = event.stream;
            logStream('remotestream of onaddstream()', stream);

            addRemoteVideo(stream.id, stream);
        };
    }

    // 로컬 ICE 후보자 가져옴
    peer.onicecandidate = function (event) {
        // Trickle ICE: 모든 후보자들이 모이기까지 기다리지 않고, 한명+a의 후보자가 모이면 전체 프로세스를 병렬처리한다
        // Vanilla ICE: 구글링실패ㅠ 추가바람

        if (event.candidate) {
            console.log(event.candidate);
            // Trickle ICE의 경우 ICE candidate를 상대쪽으로 보낸다
            // 그러나 아직 코드가 없어서 아무것도 안함

            // Vanilla ICE의 경우 아무것도 하지 않는다
        } else {
            console.log('ICE 이벤트 없음');

            if (useTrickleICE) {
                // Trickle ICE의 경우 아무것도 하지 않는다
            } else {
                // Vanilla ICE의 경우 ICE candidate를 포함한 SDP를 상대쪽으로 보낸다
                sendSdp(peer.localDescription);
            }
        }
    };

    // SDP를 교환해야 할 때
    peer.onnegotiationneeded = function (event) {
        console.log('*** onnegotiationneeded() ***');
        console.warn('*** 무시 ***');
    };

    // 다른 이벤트들
    peer.onicecandidateerror = function (event) {
        console.error('ICE candidate ERROR: ' + event);
    };
    
    peer.onsignalingstatechange = function () {
        console.log('시그널링 상태: ' + peer.signalingState);
    };
    
    peer.oniceconnectionstatechange = function () {
        console.log('ICE 커넥션 상태: ' + peer.iceConnectionState);
        showState('ICE 커넥션 상태: ' + peer.iceConnectionState);

        if (peer.iceConnectionState === 'disconnected') {
            console.log('연결 끊김, 재연결 시도 대기');
        } else if (peer.iceConnectionState === 'failed') {
            console.log('연결 실패, 연결 시도 포기');
            dissconnect();
        }
    };

    peer.onicegatheringstatechange = function () {
        console.log('ICE gathering 상태: ' + peer.iceGatheringState);
    };

    peer.onconnectionstatechange = function () {
        console.log('커넥션 상태: ' + peer.connectionState);
    };

    peer.onremovestream = function (event) {
        console.log('*** peer.onremovestream() ***');

        let stream = event.stream;
        removeRemoteVideo(stream.id, stream);
    };

    // 로컬 스트림 추가
    if (localStream) {
        console.log('로컬 스트림 추가...');

        if('addTrack' in peer) {
            console.log('addTrack() 사용');

            let tracks = localStream.getTracks();
            for (let t of tracks) {
                let sender = peer.addTrack(t, localStream);
            }
        } else {
            console.log('addStrea() 사용');
            peer.addStream(localStream);
        }
    } else {
        console.warn('로컬 스트림 없음, 그러나 계속 진행');
    }

    return peer;
}

function setOffer(sessionDescription) {
    let waitForCandidates = true;

    if (peerConnection) {
        console.log('peerConnection 이미 존재, 재사용합니다');

        if (peerConnection.remoteDescription && (peerConnection.remoteDescription.type === 'offer')) {
            // Chrome 브라우저를 사용하는 경우 Vanilla ICE를 사용하지만 재오퍼 받았으므로 후보자들을 기다리지 않는다
            if (getUsePlanB()) {
                waitForCandidates = false;
            }
        }
    } else {
        console.log('새로운 PeerConnection 준비');

        peerConnection = prepareNewConnection();
    }

    peerConnection.setRemoteDescription(sessionDescription)
        .then( function () {
            console.log('setRemoteDescription(offer) 성공');
            makeAnswer(waitForCandidates);
        })
        .catch( function (error) {
            console.error('setRemoteDescription(offer) ERROR: ' + error);
        });
}

function makeAnswer(waitForCandidates) {
    console.log('응답 보냄, remote session description 생성하는 중...');

    if (! peerConnection) {
        console.error('peerConnection 존재하지 않음!');
        return;
    }

    peerConnection.createAnswer()
        .then( function (sessionDescription) {
            console.log('createAnswer() 성공');
            return peerConnection.setLocalDescription(sessionDescription);
        })
        .then( function () {
            console.log('setLocalDescription() 성공');

            if (useTrickleICE) {
                // Trickle ICE의 경우 초기 이니셜 SDP를 상대쪽으로 보낸다
                // 그러나 아직 코드가 없어서 아무것도 안함
            } else {
                // Vanilla ICE의 경우 아직 SDP를 보내지 않고 대기한다

                // 만약 재오퍼를 받았다면, ICE 후보자가 더이상 오지 않을 것이므로 이때 SDP를 보낸다
                if (! waitForCandidates) {
                    sendSdp(peerConnection.localDescription);
                }
            }
        })
        .catch( function (error) {
            console.error(error);
        });
}

// PeerConnection 스타트
function connect() {
    callWithCapabilitySDP();
    updateButtons();
}

function callWithCapabilitySDP() {
    peerConnection = prepareNewConnection();
    peerConnection.createOffer()
        .then( function (sessionDescription) {
            console.log('createOffer() 성공');

            // setLocalDescription() 없이, 서버로 보낸다
            console.log('Capability SDP 부르는 중...');
            sendJson({
                type: 'call',
                planb: getUsePlanB(),
                capability: sessionDescription.sdp
            });
        })
        .catch( function (error) {
            console.error('callWithCapabilitySDP() ERROR: ' + error);
        });
}

// PeerConnection 닫음
function dissconnect() {
    sendJson({
        type: 'bye'
    });

    if (peerConnection) {
        console.log('끊습니다');

        peerConnection.close();
        peerConnection = null;

        removeAllRemoteVideo();
    } else {
        console.warn('peer가 존재하지 않음');
    }

    updateButtons();
}

function showState(state) {
    stateSpan.innerText = state;
}

function logStream(message, stream) {
    console.log(message + ': ID = ' + stream.id);

    let videoTracks = stream.getVideoTracks();

    if (videoTracks) {
        console.log('videoTracks.length = ' + videoTracks.length);

        videoTracks.forEach( function (t) {
            console.log(' track.id = ' + t.id);
        });
    }

    let audioTracks = stream.getAudioTracks();

    if (audioTracks) {
        console.log('audioTracks.length = ' + audioTracks.length);

        audioTracks.forEach( function (t) {
            console.log(' track.id = ' + t.id);
        });
    }
}

// 리모트 비디오 화면에 추가
function addRemoteVideo(id, stream) {
    let element = document.createElement('video');

    remoteContainer.appendChild(element);
    element.id = 'remote_' + id;
    element.width = 320;
    element.height = 240;
    element.srcObject = stream;
    element.play();
    element.volume = 0;
    element.controls = true;
}

function removeRemoteVideo(id, stream) {
    console.log('*** removeRemoteVideo() ID = ' + id);

    let element = document.getElementById('remote_' + id);

    if (element) {
        element.pause();
        element.srcObject = null;
        remoteContainer.removeChild(element);
    } else {
        console.log('child element 찾을 수 없음');
    }
}

function removeAllRemoteVideo() {
    while (remoteContainer.firstChild) {
        remoteContainer.firstChild.pause();
        remoteContainer.firstChild.srcObject = null;
        remoteContainer.removeChild(remoteContainer.firstChild);
    }
}

function updateButtons() {
    if (peerConnection) {
        disableElement('start_video_button');
        disableElement('stop_video_button');
        disableElement('connect_button');
        enableElement('disconnect_button');
        disableElement('plan_b_check');
    } else {
        if (localStream) {
            disableElement('start_video_button');
            enableElement('stop_video_button');
            enableElement('connect_button');
        } else {
            enableElement('start_video_button');
            disableElement('stop_video_button');
            disableElement('connect_button');
        }

        disableElement('disconnect_button');
        enableElement('plan_b_check');
    }
}

function enableElement(id) {
    let element = document.getElementById(id);

    if (element) {
        element.removeAttribute('disabled');
    }
}

function disableElement(id) {
    let element = document.getElementById(id);

    if (element) {
        element.setAttribute('disabled', '1');
    }
}

updateButtons();
console.log('*** 준비완료! ***');