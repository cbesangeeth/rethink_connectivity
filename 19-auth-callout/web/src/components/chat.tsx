import { Show, createMemo, onCleanup, onMount } from "solid-js";
import Sidebar from "./sidebar";
import ChannelView from "./channel-view"
import { StringCodec, connect, millis, tokenAuthenticator, usernamePasswordAuthenticator, type Consumer, type JsMsg, type NatsConnection } from "nats.ws";
import { createStore } from "solid-js/store";
import type { Message, Channel, UserID, User } from "../types";
import Login from "./login";

// represents the overall state of our
// chat application, while also allowing for
// efficient updates/appends, which is what
// we need for things like messages
interface ChatStore {
  // NATS related fields
  conn?: NatsConnection
  consumer?: Consumer

  // Represents the logged in user for publishing messages
  // to various channels. For security, we will want to lock
  // down the subjects that this user is able to publish to
  user?: User

  // Currently selected channel
  channel: Channel

  // Messages for various channels, for now we will just get
  // all messages from the beginning of time, but with NATS
  // it's quite easy to fetch from a particular time 
  // (7 days back), for instance
  messages: Record<Channel, Message[]>

  // Lookup table of user in this workspace. These user profiles will be supplied
  // by a NATS KV store
  users: Record<UserID, User>
}

const sc = StringCodec()

// TODO: These should be looked up by the workspace KV
const channels = ["general", "random", "dev"]

export default function Chat() {
  const [store, setStore] = createStore<ChatStore>({
    channel: "general",
    messages: {},
    users: {}
  })

  const workspace = createMemo(async () => {
    const conn = store.conn
    if (!conn) {
      return null
    }

    const js = conn.jetstream()
    return await js.views.kv("chat_workspace")
  })

  const onLogin = async (email: string, token: string) => {
    const b64Email = btoa(email)
    const authenticator = token ?
      tokenAuthenticator(token) :
      usernamePasswordAuthenticator("user", "pass")

    const conn = await connect({
      servers: ["ws://localhost:8222"],
      authenticator: authenticator
    })
    setStore("conn", conn)
    console.log("Connected!")
    console.log("JWT:", token)
    console.log("Email:", email)
    console.log("Email (base64):", b64Email)

    const js = conn.jetstream()
    const consumer = await js.consumers.get("chat_messages")
    setStore("consumer", consumer)

    // Look up the user in the kv store
    const ws = await workspace()
    const entry = await ws?.get(`users.${b64Email}`)

    if (!entry) {
      alert(`User does not exist for ${email}`)
      return
    }

    setStore("user", {
      ...entry.json(),
      id: b64Email
    })

    await watchWorkspace()

    const sub = await consumer.consume()
    for await (const m of sub) {
      onMessageReceived(m)
    }
  }

  const onMessageReceived = (m: JsMsg) => {
    const [_, channel, userID] = m.subject.split(".")

    const msg: Message = {
      userID: userID,
      text: m.string(),
      timestamp: new Date(millis(m.info.timestampNanos))
    }
    setStore("messages", channel, (prev) => prev ? [...prev, msg] : [msg])
  }


  // Watches information about the workspace, like users.
  // Returns a promise that is resolved when the workspace
  // info is caught up, but still runs in the background
  // for updates
  const watchWorkspace = async () => {
    return new Promise(async (res) => {
      const conn = store.conn
      if (!conn) {
        return
      }

      const ws = await workspace()
      if (ws) {
        const watcher = await ws.watch({
          initializedFn: () => res(null)
        })

        for await (const entry of watcher) {
          const [resource, ...rest] = entry.key.split(".")

          switch (resource) {
            case "users":
              // Parse and add user to the users lookup table
              const id = rest[0]
              setStore("users", id, entry.json())
              break;
          }
        }
      }
    })

  }

  onCleanup(async () => {
    console.log("closing connection...")
    await store.consumer?.delete()
    await store.conn?.close()
  })

  const sendMessage = (channel: string, message: string) => {
    if (store.user) {
      console.log("sending message", channel, message)
      store.conn?.publish(`chat.${channel}.${store.user?.id}`, sc.encode(message))
    }
  }

  const channelMessages = () => {
    return (store.messages[store.channel] || []).map((m) => {
      return {
        ...m,
        user: store.users[m.userID] ?? {
          id: "unknown",
          name: "Unknown",
          email: "Unknown",
        }
      }
    })
  }

  return (
    <Show when={store.user} fallback={<Login onSubmit={onLogin} />}>
      <div class="inset-0 w-full h-lvh absolute flex flex-row">
        <Sidebar channels={channels} selected={store.channel} onSelect={(c) => setStore("channel", c)} />
        <ChannelView channel={store.channel} onSend={sendMessage} messages={channelMessages()} />
      </div>
    </Show>
  );
}
