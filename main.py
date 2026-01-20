from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict
import json

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
        # Kullanıcıyı ismiyle beraber kaydet
        self.rooms[room_id].append({"ws": websocket, "name": username})
        
        # Bağlanınca güncel listeyi herkese duyur
        await self.broadcast_user_list(room_id)

    def disconnect(self, websocket: WebSocket, room_id: str):
        if room_id in self.rooms:
            # Kopan soketi listeden temizle
            self.rooms[room_id] = [user for user in self.rooms[room_id] if user["ws"] != websocket]
            
            # Oda boşaldıysa sil
            if not self.rooms[room_id]:
                del self.rooms[room_id]

    async def broadcast(self, message: dict, room_id: str):
        if room_id in self.rooms:
            for user in self.rooms[room_id][:]:
                try:
                    await user["ws"].send_json(message)
                except:
                    # Hata olursa disconnect çağırılır, burada pas geçiyoruz
                    pass

    async def broadcast_user_list(self, room_id: str):
        if room_id in self.rooms:
            # Sadece isimleri al
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
    return {"Status": "Co Watch Server (v5.0 UserList) 🚀"}

@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, username: str):
    await manager.connect(websocket, room_id, username)
    try:
        await manager.broadcast({
            "type": "SYSTEM",
            "message": f"{username} odaya katıldı."
        }, room_id)
        
        while True:
            try:
                data = await websocket.receive_json()
            except Exception:
                break 

            msg_type = data.get("type")

            if msg_type == "PING_MEASURE":
                await websocket.send_json(data)
                continue
            
            if msg_type == "PING":
                continue

            if msg_type == "SIGNAL":
                pass 

            # URL Değişimi veya Video Kontrolü
            if msg_type == "URL_CHANGE":
                # URL bilgisini odaya yay (Injector yakalayıp uyarı verecek)
                pass

            response = { "user": username, **data }
            await manager.broadcast(response, room_id)

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket, room_id)
        # Çıkış yapınca listeyi güncelle
        await manager.broadcast_user_list(room_id)
        try:
            await manager.broadcast({
                "type": "SYSTEM",
                "message": f"{username} ayrıldı."
            }, room_id)
        except:
            pass