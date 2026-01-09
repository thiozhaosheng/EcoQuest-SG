# EcoQuest SG

EcoQuest SG is a location-based sustainability platform that encourages eco-friendly behaviour through gamification.  
Users check in at verified green locations, earn points, maintain streaks, unlock achievement badges, and redeem rewards.

The system demonstrates a full-stack web application with authentication, geolocation validation, cloud deployment, and secure backend logic.

---

## Project Overview

EcoQuest SG was developed to promote sustainable practices in Singapore by making environmentally responsible actions engaging and rewarding.  
Instead of relying on passive awareness, the platform motivates users through real-world participation, point accumulation, and tangible rewards.

This project was built as a complete end-to-end system, covering frontend design, backend APIs, authentication, database integration, and deployment.

---

## Core Features

- Location-based check-in with distance verification
- Points and reward system
- Daily streak tracking
- Badge progression based on achievement tiers
- Public leaderboard
- Reward redemption with unique voucher codes
- Passwordless authentication using email magic links

---

## System Architecture

EcoQuest SG uses a client–server architecture:

- The frontend handles user interface, location access, and user interaction.
- The backend enforces business rules such as:
  - Geolocation distance checks
  - Daily streak validation
  - Points calculation
  - Reward redemption logic
- Supabase provides authentication and persistent storage.

All validation is performed server-side to prevent manipulation from the client.

---

## Technology Stack

**Frontend**

- HTML, CSS (Tailwind)
- Vanilla JavaScript
- Deployed on GitHub Pages

**Backend**

- Node.js with Express
- RESTful API
- Deployed on Render

**Database & Authentication**

- Supabase (PostgreSQL, Auth)

---

## Live Application

Frontend:  
https://thiozhaosheng.github.io/EcoQuest-SG/

Backend API:  
https://ecoquest-backend-uai1.onrender.com

---

## Key Learning Outcomes

This project demonstrates:

- Full-stack system design and deployment
- Secure authentication using third-party identity services
- Real-world geolocation validation
- Server-side business logic enforcement
- Integration of cloud-based databases and hosting platforms

---
