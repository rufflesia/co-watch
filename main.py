from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict
import json
import logging
from collections import deque  # Mesaj limitini yönetmek için

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
        # Canlı bağlantılar: { "oda_id": [ {ws, name}, ... ] }
        self.rooms: Dict[str, List[dict]] = {}
        
        # [YENİ] Sohbet Geçmişi: { "oda_id": [msg1, msg2, ...] }
        # Her oda için son 50 mesajı tutacağız.
        self.chat_history: Dict[str, deque] = {}

    async def connect(self, websocket: WebSocket, room_id: str, username: str):
        await websocket.accept()
        
        # Oda listesinde yoksa oluştur
        if room_id not in self.rooms:
            self.rooms[room_id] = []
            
        # Oda geçmişi yoksa oluştur (Maksimum 50 mesaj sakla)
        if room_id not in self.chat_history:
            self.chat_history[room_id] = deque(maxlen=50)

        # Kullanıcıyı ekle
        self.rooms[room_id].append({"ws": websocket, "name": username})
        logger.info(f"Baglanti: {username} -> {room_id}")

        # [YENİ] GEÇMİŞİ YÜKLE
        # Kullanıcı bağlanır bağlanmaz eski mesajları ona gönderiyoruz
        if len(self.chat_history[room_id]) > 0:
            for old_msg in self.chat_history[room_id]:
                try:
                    await websocket.send_json(old_msg)
                except:
                    pass
        
        # Güncel kullanıcı listesini yayınla
        await self.broadcast_user_list(room_id)

    def disconnect(self, websocket: WebSocket, room_id: str):
        try:
            if room_id in self.rooms:
                self.rooms[room_id] = [user for user in self.rooms[room_id] if user["ws"] != websocket]
                
                # [DEĞİŞİKLİK] Odayı hemen silmiyoruz!
                # Eğer oda boşalsa bile chat geçmişi (self.chat_history) hafızada kalsın istiyoruz.
                # Sadece bağlantı listesi boşsa o key'i silebiliriz ama history kalsın.
                if not self.rooms[room_id]:
                    del self.rooms[room_id]
                    # Not: self.chat_history[room_id] silinmediği için 
                    # odaya sonradan girenler mesajları görecek.
        except Exception as e:
            logger.error(f"Disconnect Hatasi: {e}")

    async def broadcast(self, message: dict, room_id: str):
        # [YENİ] Mesaj Kaydetme Mantığı
        # Sadece 'CHAT' tipindeki mesajları hafızaya alıyoruz.
        # Video komutlarını (PLAY/PAUSE) kaydetmeye gerek yok.
        if message.get("type") == "CHAT":
            if room_id not in self.chat_history:
                self.chat_history[room_id] = deque(maxlen=50)
            self.chat_history[room_id].append(message)

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
    return {"Status": "Co Watch Server (v7.0 Memory Enabled) 🧠"}

@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, username: str):
    await manager.connect(websocket, room_id, username)
    try:
        # Sisteme giriş bildirimi
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
        logger.error(f"Hata ({username}): {e}")
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
