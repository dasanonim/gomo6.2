import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { useLocation, useNavigate } from "react-router-dom";
import { Home, MessageCircle, UserRound, UsersRound } from "lucide-react";
import type { User } from "@/integrations/api/client";
import { useMessengerStore } from "@/stores/messengerStore";
import { NavigationLink } from "@/components/NavigationLink";
import { UserAvatar } from "@/components/UserAvatar";
import { profileUrl } from "@/utils/entityUrl";
import "./MobileBottomNav.css";

type TabId = "feed" | "communities" | "chats" | "profile";

interface MobileBottomNavProps {
  user: User | null | undefined;
}

const unreadCountSelector = (state: ReturnType<typeof useMessengerStore.getState>) =>
  state.conversations.reduce((total, conversation) => total + conversation.unread_count, 0);

export function MobileBottomNav({ user }: MobileBottomNavProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const prefersReducedMotion = useReducedMotion();
  const unreadCount = useMessengerStore(unreadCountSelector);
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    didMove: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [tabWidth, setTabWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [previewTab, setPreviewTab] = useState<TabId | null>(null);
  const indicatorX = useMotionValue(0);
  const ownProfilePath = profileUrl(user);
  const pathname = location.pathname;

  const activeTab: TabId = pathname.startsWith("/messages")
    ? "chats"
    : pathname === "/g" || pathname === "/gomosubs" || pathname.startsWith("/g/")
      ? "communities"
      : ownProfilePath &&
          (pathname === ownProfilePath || pathname.startsWith(`${ownProfilePath}/`))
        ? "profile"
        : "feed";

  const items = [
    { id: "feed" as const, label: "Лента", to: "/", Icon: Home },
    { id: "communities" as const, label: "GomoSub", to: "/g", Icon: UsersRound },
    { id: "chats" as const, label: "Чаты", to: "/messages", Icon: MessageCircle },
    {
      id: "profile" as const,
      label: "Профиль",
      to: user ? ownProfilePath : "/auth",
      Icon: UserRound,
    },
  ];

  const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeTab));

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const measure = () => setTabWidth(Math.max(0, (rail.clientWidth - 8) / items.length));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [items.length]);

  useEffect(() => {
    if (dragRef.current?.didMove || tabWidth <= 0) return;
    const controls = animate(indicatorX, activeIndex * tabWidth, {
      ...(prefersReducedMotion
        ? { duration: 0 }
        : { type: "spring" as const, stiffness: 430, damping: 34, mass: 0.72 }),
    });
    return () => controls.stop();
  }, [activeIndex, indicatorX, prefersReducedMotion, tabWidth]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || tabWidth <= 0) return;
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-mobile-tab]");
    if (item?.dataset.mobileTab !== activeTab) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      didMove: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.didMove && Math.abs(deltaX) < 5 && Math.abs(deltaY) < 8) return;
    if (Math.abs(deltaY) > Math.abs(deltaX) * 1.4) return;

    drag.didMove = true;
    setDragging(true);
    event.preventDefault();

    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    const maxX = tabWidth * (items.length - 1);
    const rawX = event.clientX - rect.left - 5 - tabWidth / 2;
    const nextX = Math.max(0, Math.min(maxX, rawX));
    indicatorX.set(nextX);

    const index = Math.max(0, Math.min(items.length - 1, Math.round(nextX / tabWidth)));
    setPreviewTab(items[index].id);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const didDrag = drag.didMove;
    setDragging(false);
    setPreviewTab(null);
    if (!didDrag) return;

    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (cancelled || tabWidth <= 0) {
      animate(indicatorX, activeIndex * tabWidth, {
        ...(prefersReducedMotion
          ? { duration: 0 }
          : { type: "spring" as const, stiffness: 430, damping: 34, mass: 0.72 }),
      });
      return;
    }

    const rail = railRef.current;
    if (rail) {
      const rect = rail.getBoundingClientRect();
      const maxX = tabWidth * (items.length - 1);
      const releaseX = event.clientX - rect.left - 5 - tabWidth / 2;
      indicatorX.set(Math.max(0, Math.min(maxX, releaseX)));
    }

    const index = Math.max(
      0,
      Math.min(items.length - 1, Math.round(indicatorX.get() / tabWidth)),
    );
    const target = items[index];
    if (target.id !== activeTab) {
      navigate(target.to);
    } else {
      animate(indicatorX, activeIndex * tabWidth, {
        ...(prefersReducedMotion
          ? { duration: 0 }
          : { type: "spring" as const, stiffness: 430, damping: 34, mass: 0.72 }),
      });
    }
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <nav className="mobile-bottom-nav" aria-label="Основная навигация">
      <div
        ref={railRef}
        className={`mobile-bottom-nav__rail${dragging ? " is-dragging" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={(event) => finishDrag(event, true)}
        onClickCapture={onClickCapture}
        onContextMenu={(event) => event.preventDefault()}
      >
        <motion.span
          className={`mobile-bottom-nav__active-pill${dragging ? " is-dragging" : ""}`}
          style={{ x: indicatorX, scale: dragging ? 1.035 : 1 }}
          aria-hidden="true"
        />
        {items.map(({ id, label, to, Icon }) => {
          const isActive = id === (dragging && previewTab ? previewTab : activeTab);
          const isProfile = id === "profile";

          return (
            <NavigationLink
              key={id}
              to={to}
              data-mobile-tab={id}
              draggable={false}
              prefetchData={id !== "profile" || !!user}
              aria-current={id === activeTab ? "page" : undefined}
              aria-label={
                id === "chats" && unreadCount > 0
                  ? `${label}, ${unreadCount} непрочитанных`
                  : label
              }
              className={`mobile-bottom-nav__item${isActive ? " is-active" : ""}`}
              onDragStart={(event) => event.preventDefault()}
            >
              <span className="mobile-bottom-nav__icon-wrap">
                {isProfile && user?.avatar_url ? (
                  <UserAvatar
                    src={user.avatar_url}
                    userId={user.id}
                    alt=""
                    className="mobile-bottom-nav__profile-avatar"
                  />
                ) : (
                  <Icon className="mobile-bottom-nav__icon" aria-hidden="true" />
                )}
                {id === "chats" && unreadCount > 0 && (
                  <span className="mobile-bottom-nav__badge" aria-label={`${unreadCount} непрочитанных`}>
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </span>
              <span className="mobile-bottom-nav__label">{label}</span>
              {isProfile && user && <span className="sr-only">Ваш профиль</span>}
            </NavigationLink>
          );
        })}
      </div>
    </nav>
  );
}
