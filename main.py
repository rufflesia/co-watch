from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict
import json
import logging

# Loglama ayarı (Hataları terminalde görmek için)
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
        # Yapı: { "oda_id": [ {"ws": WebSocket, "name": "Yusuf"}, ... ] }
        self.rooms: Dict[str, List[dict]] = {}

    async def connect(self, websocket: WebSocket, room_id: str, username: str):
        await websocket.accept()
        if room_id not in self.rooms:
            self.rooms[room_id] = []
        self.rooms[room_id].append({"ws": websocket, "name": username})
        logger.info(f"Baglanti: {username} -> {room_id}")
        await self.broadcast_user_list(room_id)

    def disconnect(self, websocket: WebSocket, room_id: str):
        try:
            if room_id in self.rooms:
                # Kullanıcıyı listeden çıkar
                self.rooms[room_id] = [user for user in self.rooms[room_id] if user["ws"] != websocket]
                
                # Oda boşaldıysa sil (Memory leak önleme)
                if not self.rooms[room_id]:
                    del self.rooms[room_id]
        except Exception as e:
            logger.error(f"Disconnect Hatasi: {e}")

    async def broadcast(self, message: dict, room_id: str):
        """
        Mesajı odadaki herkese iletir.
        Eğer bir soket ölü ise, onu temizler ve hatayı yutmaz, loglar.
        """
        if room_id in self.rooms:
            # Listeyi kopyalayarak dönüyoruz (döngü sırasında silme işlemi güvenli olsun diye)
            for user in self.rooms[room_id][:]:
                try:
                    await user["ws"].send_json(message)
                except Exception as e:
                    # Soket ölmüş olabilir, listeden temizle
                    logger.warning(f"Ölü soket tespit edildi, temizleniyor: {user['name']}")
                    try:
                        self.rooms[room_id].remove(user)
                    except:
                        pass # Zaten silindiyse sorun yok

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
    return {"Status": "Co Watch Server (v6.1 Connection Fix) 🚀"}

@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, username: str):
    await manager.connect(websocket, room_id, username)
    try:
        # 1. Bağlantı Başarılı Mesajı
        await manager.broadcast({
            "type": "SYSTEM",
            "message": f"{username} odaya katıldı."
        }, room_id)
        
        while True:
            # Veri bekleme (JSON formatında)
            data = await websocket.receive_json()
            msg_type = data.get("type")

            # A) GECİKME ÖLÇER
            if msg_type == "PING_MEASURE":
                await websocket.send_json(data)
                continue
            
            # B) KALP ATIŞI (Keep-Alive)
            # Render/Amazon gibi load balancer'lar idle bağlantıyı keser.
            # Client 'PING' attığında sunucu 'PONG' dönerek hattı canlı tutar.
            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
                continue

            # Diğer tüm mesajları (Video, Chat, Sinyal) odaya dağıt
            response = { "user": username, **data }
            await manager.broadcast(response, room_id)

    except WebSocketDisconnect:
        logger.info(f"WebSocket koptu: {username}")
    except Exception as e:
        logger.error(f"Beklenmeyen Hata ({username}): {e}")
        # Hata olsa bile döngüyü kırıp finally bloğuna gitmesini sağlıyoruz
    finally:
        # --- KRİTİK BÖLGE: KOPMA DURUMUNDA ÇALIŞACAK KODLAR ---
        
        # 1. Kullanıcıyı listeden sil
        manager.disconnect(websocket, room_id)
        
        # 2. Kullanıcı listesini güncelle
        await manager.broadcast_user_list(room_id)
        
        # 3. Ayrıldı bildirimini gönder (Hata yutmadan!)
        try:
            logger.info(f"Ayrılma bildirimi gönderiliyor: {username}")
            await manager.broadcast({
                "type": "SYSTEM",
                "message": f"{username} ayrıldı (Bağlantı koptu)."
            }, room_id)
        except Exception as broadcast_error:
            logger.error(f"Bildirim gonderilemedi: {broadcast_error}")
