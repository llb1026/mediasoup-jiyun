'use strict';

// SSL certification 파일들 읽어오기
const https = require('https');
const fs = require('fs');
var options = {
    key: fs.readFileSync('cert/key.pem').toString(),
    cert: fs.readFileSync('cert/cert.pem').toString()
};

const WebSocketServer = require('ws').Server;
/*
const wsServer = new WebSocketServer({ port: 3001 });
console.log('웹소켓 서버 스타트! 3001번 포트입니다');
*/

const express = require('express');
const app = express();
app.use(express.static('public'));
/*
const webServer = app.listen(3000, function () {
    console.log('웹서버 스타트! http://localhost:' + webServer.address().port + '/');
});
*/

// https 연결을 위한 서버 새로 생성
const webServer = https.createServer( options, app ).listen(3000, function () {
    console.log('웹서버 스타트! https://localhost:' + webServer.address().port + '/');
});

const wsServer = new WebSocketServer({ server: webServer });
console.log('웹소켓 서버 스타트! ' + webServer.address().port + '번 포트입니다');

const mediasoup = require('mediasoup');
const RTCPeerConnection = mediasoup.webrtc.RTCPeerConnection;
const RTCSessionDescription = mediasoup.webrtc.RTCSessionDescription;
const roomOptions = require('./data/options').roomOptions;
const peerCapabilities = require('./data/options').peerCapabilities;

let selfId = null;
let soupRoom = null;
let Connections = new Array();
let clientIndex = 0;

// 미디어숲
let server = mediasoup.Server();
server.createRoom(roomOptions)
    .then( (room) => {
        soupRoom = room;
        console.log('server.createRoom() 성공!');
        console.log('여기는 ' + getRoomName() + ' Room입니다!');
    })
    .catch( (err) => console.error('server.createRoom() ERROR: ' + err));

// 웹소켓 서버
function getId(ws) {
    if (ws.additionalId) {
        return ws.additionalId;
    } else {
        clientIndex++;
        ws.additionalId = 'member_' + clientIndex;
        return ws.additionalId;
    }
}

function getClientCount() {
    return wsServer.clients.length;
}

wsServer.on('connection', function connection(ws) {
    console.log('클라이언트 연결됨. ID = ' + getId(ws) + ', 총 클라이언트는 ' + getClientCount());

    ws.on('close', function () {
        console.log('클라이언트 연결 닫힘. ID = ' + getId(ws) + ', 총 클라이언트는 ' + getClientCount());
        cleanUpPeer(ws);
    });

    ws.on('error', function (err) {
        console.error('에러! ' + err);
    });

    ws.on('message', function incoming(data) {
        const inMessage = JSON.parse(data);
        const id = getId(ws);
        console.log('ID %s 받음, 타입은 %s', id, inMessage.type);

        if (inMessage.type === 'call') {
            console.log('ID %s 로부터 콜 받음', id);
            let message = { sendto: id, type: 'response' };
            console.log('ID %s 에게 오퍼 보냄', id);

            // PeerConnection 준비, SDP 보냄
            // SDP(Session Description Protocol): 연결하고자 하는 Peer 서로간의 미디어와 네트워크에 관한 정보를 이해하기 위해 사용된다
            // offer와 answer시에 주고받는 방식
            // 참고로 offer answer는 JSEP(Javascript Session Establishment Protocol)에 따른다
            // 자세한 설명은 링크(https://cryingnavi.github.io/WebRTC-SDP/)
            const downOnlyRequested = false;
            preparePeer(ws, inMessage, downOnlyRequested);
        } else if (inMessage.type === 'call_downstream') {
            // 리얼타임 스트리밍을 위해 요청된 다운스트림만 허용
            const downOnlyRequested = true;
            preparePeer(ws, inMessage, downOnlyRequested);
        } else if (inMessage.type === 'offer') {
            console.log('ID %s 로부터 오퍼 받음', id);
            console.error('절대 오퍼 받아서는 안됨');
        } else if (inMessage.type === 'answer') {
            console.log('ID %s 로부터 응답 받음', id);
            handleAnswer(ws, inMessage);
        } else if (inMessage.type === 'candidate') {
            console.error('절대 후보 받아서는 안됨');
        } else if (inMessage.type === 'bye') {
            cleanUpPeer(ws);
        }
    });

    sendback(ws, { type: 'welcome' });
});

// 웹소켓을 통해 보냄
function sendback(ws, message) {
    let str = JSON.stringify(message);
    ws.send(str);
}

function preparePeer(ws, message, downOnly) {
    const id = getId(ws);
    const planb = message.planb;
    const capabilitySDP = message.capability;

    let peer = soupRoom.Peer(id);
    let peerconnection = new RTCPeerConnection({
        peer: peer,
        usePlanB: planb
    });
    console.log('*** RTCPeerConnection 생성 ***');
    console.log('*** 방 안에 peer들 = ' + soupRoom.peers.length);

    peerconnection.on('close', function (err) {
        console.log('*** PeerConnection.closed, err: ' + err);
    });

    peerconnection.on('signalingstatechange', function () {
        console.log('*** PeerConnection.signalingstatechanged, state: ' + peerconnection.signalingState);
    });

    peerconnection.on('negotiationneeded', () => {
        console.log('*** PeerConnection.negotiationneeded!!! id: ' + id);

        // 여기서 SDP 보냄
        sendOffer(ws, peerconnection, downOnly);
    });

    peerconnection.setCapabilities(capabilitySDP)
        .then( () => {
            console.log('peerconnection.setCapabilities() OK');
            addPeerConnection(id, peerconnection);
            sendOffer(ws, peerconnection);
        })
        .catch( (err) => {
            console.log('peerconnection.setCapabilities() ERROR: ' + err);
            peerconnection.close();
        })
}

function sendOffer(ws, peerconnection, downOnly) {
    const id = getId(ws);
    console.log('ID %s 에 오퍼', id);

    let offerOption = {
        offerToReceiveAudio: 1,
        offerToReceiveVideo: 1
    };

    if (downOnly) {
        offerOption.offerToReceiveAudio = 0;
        offerOption.offerToReceiveVideo = 0;
    }

    peerconnection.createOffer(offerOption)
        // PeerConnection으로부터 SD 생성
        .then( (desc) => {
            return peerconnection.setLocalDescription(desc);
        })

        // 생성된 SD를 상대방에게 전송하고, 전송한 SD를 PeerConnection 객체의 local로 설정
        .then( () => {
            dumpPeer(peerconnection.peer, 'peer.dump after createOffer');
            sendSDP(ws, peerconnection.localDescription);
        })
        .catch( (error) => {
            console.error('참여자에게 보내는 SDP 오퍼 핸들링 에러: %s', error);

            // peerconnection 닫음
            peerconnection.reset();
            peerconnection.close();
            deletePeerConnection(id);
        });
}

function handleAnswer(ws, message) {
    const id = getId(ws);

    let peerconnection = getPeerConnection(id);

    if (! peerconnection) {
        console.warn('경고: 커넥션 찾을 수 없음, ID = ' + id);
        return;
    }

    let desc = new RTCSessionDescription({
        type: 'answer',
        sdp: message.sdp
    });

    // offer를 통해 건네받은 SD를 PeerConnection의 remote로 설정
    peerconnection.setRemoteDescription(desc)
        .then( function () {
            console.log('setRemoteDescription for Answer OK, ID = ' + id);
            console.log('*** 방 안에 peer들 = ' + soupRoom.peers.length);

            // answer를 위해 생성한 SD로 상대방에게 answer를 전달
            dumpPeer(peerconnection.peer, 'peer.dump after setRemoteDescription(answer):');
        })
        .catch( (err) => {
            console.error('setRemoteDescription for Answer ERROR: ' + err);
        });
}

function dumpPeer(peer, caption) {
    console.log(caption + '! 전송 = %d, 받는사람들 = %d, 보내는사람들 = %d', peer.transports.length, peer.rtpReceivers.length, peer.rtpSenders.length);

    // 디버깅용
    // peer.dump()
    //     .then( (obj) => {
    //         console.log(caption, obj)
    //     });
}

function addPeerConnection(id, pc) {
    Connections[id] = pc;
}

function getPeerConnection(id) {
    const pc = Connections[id];
    return pc;
}

function deletePeerConnection(id) {
    delete Connections[id];
}

function cleanUpPeer(ws) {
    const id = getId(ws);

    let peerconnection = getPeerConnection(id);

    if(! peerconnection) {
        console.warn('경고: cleanUpPeer(id), 커넥션 찾을 수 없음, ID = ' + id);
        return;
    }

    console.log('PeerConnection 닫힘, ID = ' + id);
    peerconnection.close();
    deletePeerConnection(id);

    console.log('*** 방 안에 peer들 = ' + soupRoom.peers.length);
}

function sendSDP(ws, sessionDescription) {
    const id = getId(ws);

    let message = {
        sendto: id,
        type: sessionDescription.type,
        sdp: sessionDescription.sdp
    };

    console.log('*** SDP 보냄 ***');
    console.log('sendto: ' + message.sendto + ', type: ' + message.type);

    sendback(ws, message);
}

// 룸 이름 리턴
function getRoomName() {
    var room = 'jiyun';
    if (process.argv.length > 2) {
        room = process.argv[2];
    }
    return room;
}