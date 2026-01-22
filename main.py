from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict
import json
import logging

# Loglama ayarı
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("CoWatchServer")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectionManager:
    def __init__(self):
        # Odadaki Kullanıcılar: { "oda_id": [ {"ws": WebSocket, "name": "Yusuf"}, ... ] }
        self.rooms: Dict[str, List[dict]] = {}
        
        # [YENİ] Odaların URL Hafızası: { "oda_id": "https://youtube.com/..." }
        self.room_urls: Dict[str, str] = {}

    async def connect(self, websocket: WebSocket, room_id: str, username: str):
        await websocket.accept()
        if room_id not in self.rooms:
            self.rooms[room_id] = []
        self.rooms[room_id].append({"ws": websocket, "name": username})
        
        logger.info(f"Baglanti: {username} -> {room_id}")
        
        # 1. Kullanıcı Listesini Güncelle
        await self.broadcast_user_list(room_id)

        # [YENİ] 2. Odanın URL'ini Yeni Gelene Bildir (Varsa)
        if room_id in self.room_urls:
            current_url = self.room_urls[room_id]
            logger.info(f"Yeni kullanıcıya URL senkronize ediliyor: {current_url}")
            await websocket.send_json({
                "type": "SYNC_URL",
                "url": current_url,
                "user": "Sistem"
            })

    def disconnect(self, websocket: WebSocket, room_id: str):
        try:
            if room_id in self.rooms:
                self.rooms[room_id] = [user for user in self.rooms[room_id] if user["ws"] != websocket]
                
                # Oda boşaldıysa hem listeyi hem URL hafızasını sil
                if not self.rooms[room_id]:
                    del self.rooms[room_id]
                    if room_id in self.room_urls:
                        del self.room_urls[room_id]
        except Exception as e:
            logger.error(f"Disconnect Hatasi: {e}")

    async def broadcast(self, message: dict, room_id: str):
        # [YENİ] Eğer URL değiştiyse hafızaya kaydet
        if message.get("type") == "URL_CHANGE":
            new_url = message.get("url")
            if new_url:
                self.room_urls[room_id] = new_url
                logger.info(f"Oda {room_id} URL değişti: {new_url}")

        if room_id in self.rooms:
            for user in self.rooms[room_id][:]:
                try:
                    await user["ws"].send_json(message)
                except Exception as e:
                    logger.warning(f"Ölü soket temizleniyor: {user['name']}")
                    try:
                        self.rooms[room_id].remove(user)
                    except:
                        pass

    async def broadcast_user_list(self, room_id: str):
        if room_id in self.rooms:
            user_names = [user["name"] for user in self.rooms[room_id]]
            message = {
                "type": "USER_LIST",
                "users": user_names,
                "count": len(user_names)
            }
            await self.broadcast(message, room_id)

manager = ConnectionManager()

@app.get("/")
def read_root():
    return {"Status": "Co Watch Server (v2.0 URL Sync) 🚀"}

@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, username: str):
    await manager.connect(websocket, room_id, username)
    try:
        await manager.broadcast({
            "type": "SYSTEM",
            "message": f"{username} odaya katıldı."
        }, room_id)
        
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "PING_MEASURE":
                await websocket.send_json(data)
                continue
            
            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
                continue

            response = { "user": username, **data }
            await manager.broadcast(response, room_id)

    except WebSocketDisconnect:
        logger.info(f"WebSocket koptu: {username}")
    except Exception as e:
        logger.error(f"Hata: {e}")
    finally:
        manager.disconnect(websocket, room_id)
        await manager.broadcast_user_list(room_id)
        try:
            await manager.broadcast({
                "type": "SYSTEM",
                "message": f"{username} ayrıldı."
            }, room_id)
        except:
            pass
